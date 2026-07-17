"""Pruebas del auto-avance de las pausas restantes del editor (bugfix).

Bugfix ``cloud-edicion-final-cuelga-80``: tras arreglar el cuelgue al 25 %
(auto-aplicar silencios), el pipeline se colgaba al 80 %
(``ESPERANDO_EDICION_FINAL``, flag ``pendiente_eleccion_render``) porque el flujo
integrado de Cloud Run no surface ni reanuda la pausa de edición final (elección
de motor de render + previsualización). La pausa ``ESPERANDO_REVISION`` (revisión
manual de subtítulos) sufriría lo mismo si estuviera activada.

Fix: en modo cloud (o bajo el flag ``VSE_EDIT_AUTO_ADVANCE``) se AUTO-AVANZAN
TODAS las pausas manuales del editor encadenando las reanudaciones hasta
COMPLETADO:

- ``pendiente_edicion_silencios`` → auto-aplicar silencios (gobernado por
  ``VSE_SILENCE_AUTO_APPLY`` / cloud, ya existente).
- ``pendiente_revision`` → auto-aprobar los grupos tal cual.
- ``pendiente_eleccion_render`` → auto-renderizar con Remotion (motor por
  defecto).

En modo local (sin flags) se conservan TODAS las pausas actuales.

Estas pruebas usan **dobles inyectados** y **sin binarios reales**.
"""

from __future__ import annotations

from pathlib import Path
from typing import List, Optional, Sequence, Tuple

import pytest

from app import config
from app.engine.proc import ResultadoComando
from app.engine.silence import ResultadoDeteccionSilencios
from app.jobs.manager import JobManager
from app.jobs.runner import JobRunner
from app.models.job import JobStatus
from app.models.settings import Ajustes, Palabra
from app.storage.workdir import JobWorkdir


# ===========================================================================
# Fixtures e infraestructura común (mismo patrón que las pruebas existentes)
# ===========================================================================
@pytest.fixture(autouse=True)
def _aislar_workdir(tmp_path, monkeypatch):
    """Aísla ``WORKDIR_ROOT``/``OUTPUT_ROOT`` en un directorio temporal por test."""
    monkeypatch.setattr(config, "WORKDIR_ROOT", tmp_path / "work")
    monkeypatch.setattr(config, "OUTPUT_ROOT", tmp_path / "out")


@pytest.fixture(autouse=True)
def _entorno_limpio(monkeypatch):
    """Parte de un entorno determinista: sin flags ni modo cloud."""
    monkeypatch.delenv("VSE_SILENCE_AUTO_APPLY", raising=False)
    monkeypatch.delenv("VSE_EDIT_AUTO_ADVANCE", raising=False)
    monkeypatch.delenv("EDIT_MODE", raising=False)


def _cmd_ok(args: Sequence[str], timeout: Optional[float] = None) -> ResultadoComando:
    """Ejecutor de comandos doble: siempre éxito (no invoca binarios reales)."""
    return ResultadoComando(returncode=0, stdout="1.0", stderr="", args=list(args))


class _Dobles:
    """Dobles inyectables de TODOS los pasos del pipeline (fase inicial + reanudación).

    Registra el orden de los pasos en ``llamadas`` para verificar el flujo
    completo de auto-avance. Escribe artefactos reales (pequeños) en el workdir.
    """

    def __init__(
        self, silencios: Sequence[Tuple[float, float]], duracion: float
    ) -> None:
        self.silencios = list(silencios)
        self.duracion = duracion
        self.llamadas: List[str] = []
        self.tramos_aplicados: Optional[list] = None

    def fn_unir(self, job: JobWorkdir, orden, ancho, alto, fps, **kw) -> Path:  # noqa: ANN001
        self.llamadas.append("UNIR")
        ruta = job.resolve("unido.mp4")
        ruta.write_bytes(b"unido")
        return ruta

    def fn_detectar(
        self, entrada, *, umbral_db, margen_ms, modo="db", runner=None, **kw
    ) -> ResultadoDeteccionSilencios:  # noqa: ANN001
        self.llamadas.append("DETECTAR")
        return ResultadoDeteccionSilencios(
            silencios=list(self.silencios), duracion=self.duracion
        )

    def fn_transcribir(self, entrada, ajustes_t, audio, *, runner=None, **kw):  # noqa: ANN001
        self.llamadas.append("TRANSCRIBIR")
        return [
            Palabra(texto="hola", inicio_s=0.0, fin_s=0.5),
            Palabra(texto="mundo", inicio_s=0.5, fin_s=1.0),
        ]

    def fn_subtitulos(self, entrada, palabras, sub, res, ass, salida, **kw) -> Path:  # noqa: ANN001
        self.llamadas.append("SUBTITULOS_ASS")
        return Path(salida)

    def fn_musica(self, entrada, mwav, mus, salida, **kw) -> Path:  # noqa: ANN001
        self.llamadas.append("MUSICA")
        return Path(salida)

    def fn_preservar(self, job: JobWorkdir, tmp) -> Path:  # noqa: ANN001
        self.llamadas.append("PRESERVAR")
        return job.output_path

    def fn_aplicar(self, entrada, salida, tramos, duracion, *, runner=None, **kw) -> Path:  # noqa: ANN001
        self.llamadas.append("APLICAR")
        self.tramos_aplicados = list(tramos)
        Path(salida).write_bytes(b"cortado")
        return Path(salida)

    def fn_remotion(self, entrada, grupos, sub, res, fps, props, salida, **kw) -> Path:  # noqa: ANN001
        self.llamadas.append("REMOTION")
        Path(salida).write_bytes(b"render")
        return Path(salida)

    def inyecciones(self) -> dict:
        return dict(
            fn_unir=self.fn_unir,
            fn_detectar=self.fn_detectar,
            fn_transcribir=self.fn_transcribir,
            fn_subtitulos=self.fn_subtitulos,
            fn_musica=self.fn_musica,
            fn_preservar=self.fn_preservar,
            fn_aplicar=self.fn_aplicar,
            fn_remotion=self.fn_remotion,
        )


def _ajustes(*, silencios_activado: bool, revisar: bool) -> Ajustes:
    ajustes = Ajustes()
    ajustes.silencios.activado = silencios_activado
    ajustes.subtitulos.revisar = revisar
    return ajustes


def _runner(manager: JobManager, dobles: _Dobles) -> JobRunner:
    return JobRunner(manager, runner=_cmd_ok, **dobles.inyecciones())


# ===========================================================================
# (1) Modo cloud/flag, revisar=False → COMPLETADO end-to-end sin quedar en
#     ESPERANDO_EDICION_FINAL
# ===========================================================================
def test_auto_avance_flag_revisar_false_llega_a_completado(monkeypatch) -> None:
    """Con ``VSE_EDIT_AUTO_ADVANCE=1`` (y auto-apply de silencios), un job con
    silencios + subtítulos (revisar=False) llega a COMPLETADO en una sola
    ejecución: aplicar-silencios → transcribir → render (remotion) → preservar,
    SIN quedar en ESPERANDO_EDICION_FINAL."""
    monkeypatch.setenv("VSE_SILENCE_AUTO_APPLY", "1")
    monkeypatch.setenv("VSE_EDIT_AUTO_ADVANCE", "1")
    manager = JobManager()
    dobles = _Dobles(silencios=[(1.0, 2.0), (4.0, 5.5)], duracion=10.0)
    runner = _runner(manager, dobles)

    manager.crear_job(
        "job-ff", ["c1"], _ajustes(silencios_activado=True, revisar=False), workdir="wd"
    )

    resultado = runner.ejecutar_job("job-ff")

    # Estado terminal: COMPLETADO (no queda en ninguna pausa).
    assert resultado.exito is True
    estado = manager.obtener("job-ff").progreso.estado
    assert estado == JobStatus.COMPLETADO
    assert estado != JobStatus.ESPERANDO_EDICION_FINAL
    assert manager.obtener("job-ff").progreso.porcentaje == 100

    # Se aplicaron EXACTAMENTE los tramos detectados y se recorrió todo el flujo.
    assert dobles.tramos_aplicados == [(1.0, 2.0), (4.0, 5.5)]
    assert dobles.llamadas == [
        "UNIR",
        "DETECTAR",
        "APLICAR",
        "TRANSCRIBIR",
        "REMOTION",
        "PRESERVAR",
    ]


def test_auto_avance_cloud_mode_revisar_false_llega_a_completado(monkeypatch) -> None:
    """Sin flags explícitos pero en modo cloud (``EDIT_MODE=cloud``), el default
    auto-avanza todas las pausas y el job llega a COMPLETADO."""
    monkeypatch.setenv("EDIT_MODE", "cloud")
    manager = JobManager()
    dobles = _Dobles(silencios=[(2.0, 3.0)], duracion=8.0)
    runner = _runner(manager, dobles)

    manager.crear_job(
        "job-cloud", ["c1"], _ajustes(silencios_activado=True, revisar=False), workdir="wd"
    )

    resultado = runner.ejecutar_job("job-cloud")

    assert resultado.exito is True
    assert manager.obtener("job-cloud").progreso.estado == JobStatus.COMPLETADO
    assert "REMOTION" in dobles.llamadas and "PRESERVAR" in dobles.llamadas


# ===========================================================================
# (2) Modo cloud con revisar=True → COMPLETADO pasando por la auto-aprobación
#     de la revisión
# ===========================================================================
def test_auto_avance_cloud_mode_revisar_true_llega_a_completado(monkeypatch) -> None:
    """Con ``EDIT_MODE=cloud`` y revisar=True, el pipeline auto-aprueba la
    revisión de subtítulos y llega igualmente a COMPLETADO, pasando por la fase
    de subtítulos (SUBTITULOS_ASS) antes del render final."""
    monkeypatch.setenv("EDIT_MODE", "cloud")
    manager = JobManager()
    dobles = _Dobles(silencios=[(1.0, 2.0)], duracion=10.0)
    runner = _runner(manager, dobles)

    manager.crear_job(
        "job-rev", ["c1"], _ajustes(silencios_activado=True, revisar=True), workdir="wd"
    )

    resultado = runner.ejecutar_job("job-rev")

    assert resultado.exito is True
    assert manager.obtener("job-rev").progreso.estado == JobStatus.COMPLETADO
    assert manager.obtener("job-rev").progreso.porcentaje == 100
    # Con revisar=True el flujo pasa por la fase de revisión (SUBTITULOS_ASS) y
    # luego auto-aprueba y renderiza con Remotion.
    assert "APLICAR" in dobles.llamadas
    assert "TRANSCRIBIR" in dobles.llamadas
    assert "REMOTION" in dobles.llamadas
    assert "PRESERVAR" in dobles.llamadas


def test_auto_avance_flag_revisar_true_llega_a_completado(monkeypatch) -> None:
    """Con ``VSE_EDIT_AUTO_ADVANCE=1`` (local + flag) y revisar=True también
    llega a COMPLETADO. El flag de silencios se activa aparte."""
    monkeypatch.setenv("VSE_SILENCE_AUTO_APPLY", "1")
    monkeypatch.setenv("VSE_EDIT_AUTO_ADVANCE", "1")
    manager = JobManager()
    dobles = _Dobles(silencios=[(1.0, 2.0)], duracion=10.0)
    runner = _runner(manager, dobles)

    manager.crear_job(
        "job-rev2", ["c1"], _ajustes(silencios_activado=True, revisar=True), workdir="wd"
    )

    resultado = runner.ejecutar_job("job-rev2")

    assert resultado.exito is True
    assert manager.obtener("job-rev2").progreso.estado == JobStatus.COMPLETADO


# ===========================================================================
# (3) Modo local (sin flags) → se conservan TODAS las pausas actuales
# ===========================================================================
def test_local_sin_flags_conserva_pausa_silencios(monkeypatch) -> None:
    """Sin flags y en modo local (default) el job queda pausado en la primera
    pausa (ESPERANDO_EDICION_SILENCIOS): no se auto-avanza nada."""
    manager = JobManager()
    dobles = _Dobles(silencios=[(1.0, 2.0)], duracion=10.0)
    runner = _runner(manager, dobles)

    manager.crear_job(
        "job-local", ["c1"], _ajustes(silencios_activado=True, revisar=False), workdir="wd"
    )

    resultado = runner.ejecutar_job("job-local")

    assert resultado.pendiente_edicion_silencios is True
    assert (
        manager.obtener("job-local").progreso.estado
        == JobStatus.ESPERANDO_EDICION_SILENCIOS
    )
    assert "APLICAR" not in dobles.llamadas
    assert "REMOTION" not in dobles.llamadas


def test_local_sin_flags_conserva_pausa_edicion_final(monkeypatch) -> None:
    """Sin flags y con silencios desactivados, el job se pausa en
    ESPERANDO_EDICION_FINAL (comportamiento histórico) y NO se auto-renderiza."""
    manager = JobManager()
    dobles = _Dobles(silencios=[], duracion=5.0)
    runner = _runner(manager, dobles)

    manager.crear_job(
        "job-local2", ["c1"], _ajustes(silencios_activado=False, revisar=False), workdir="wd"
    )

    resultado = runner.ejecutar_job("job-local2")

    assert resultado.pendiente_eleccion_render is True
    assert (
        manager.obtener("job-local2").progreso.estado
        == JobStatus.ESPERANDO_EDICION_FINAL
    )
    assert "REMOTION" not in dobles.llamadas
    assert "PRESERVAR" not in dobles.llamadas


# ===========================================================================
# (4) Unit del helper config.auto_avanzar_edicion()
# ===========================================================================
def test_auto_avanzar_edicion_env_truthy(monkeypatch) -> None:
    """La env truthy fuerza auto-avance=True aun en modo local."""
    monkeypatch.delenv("EDIT_MODE", raising=False)  # local
    for valor in ("1", "true", "TRUE", "yes", "Yes"):
        monkeypatch.setenv("VSE_EDIT_AUTO_ADVANCE", valor)
        assert config.auto_avanzar_edicion() is True, valor


def test_auto_avanzar_edicion_env_falsy(monkeypatch) -> None:
    """La env con un valor explícito no-truthy fuerza auto-avance=False aun en cloud."""
    monkeypatch.setenv("EDIT_MODE", "cloud")
    for valor in ("0", "false", "no", "off"):
        monkeypatch.setenv("VSE_EDIT_AUTO_ADVANCE", valor)
        assert config.auto_avanzar_edicion() is False, valor


def test_auto_avanzar_edicion_env_ausente_cloud(monkeypatch) -> None:
    """Sin la env, en modo cloud el default es auto-avance=True."""
    monkeypatch.delenv("VSE_EDIT_AUTO_ADVANCE", raising=False)
    monkeypatch.setenv("EDIT_MODE", "cloud")
    assert config.auto_avanzar_edicion() is True


def test_auto_avanzar_edicion_env_ausente_local(monkeypatch) -> None:
    """Sin la env, en modo local el default es auto-avance=False (pausas manuales)."""
    monkeypatch.delenv("VSE_EDIT_AUTO_ADVANCE", raising=False)
    monkeypatch.delenv("EDIT_MODE", raising=False)
    assert config.auto_avanzar_edicion() is False
