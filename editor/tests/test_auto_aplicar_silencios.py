"""Pruebas del auto-aplicado de silencios en modo cloud/flag (bugfix).

Bugfix ``cloud-silencios-cuelga-25``: el pipeline se colgaba indefinidamente al
25 % cuando "cortar silencios" estaba activado, porque tras detectar los
silencios el runner PAUSABA en ``ESPERANDO_EDICION_SILENCIOS`` esperando un
``POST /silencios/{id}`` desde un timeline manual que el flujo integrado de Cloud
Run nunca surface ni reanuda → espera infinita (sin timeout).

Fix: en modo cloud (o bajo el flag ``VSE_SILENCE_AUTO_APPLY``) NO se pausa; se
auto-aplican los tramos detectados y se continúa el pipeline. En modo
local/standalone (sin el flag) se conserva la pausa manual con timeline.

Estas pruebas verifican, con **dobles inyectados** y **sin binarios reales**:

1. Con auto-apply activado (flag o cloud mode) un job con silencios activados NO
   queda en ``ESPERANDO_EDICION_SILENCIOS``; el pipeline continúa (aplica los
   tramos detectados vía el runner) hasta la siguiente pausa, y se llamó a la
   aplicación de cortes con los tramos detectados.
2. Con auto-apply desactivado (local, sin la env) se conserva la pausa
   ``ESPERANDO_EDICION_SILENCIOS`` (comportamiento histórico).
3. Unit del helper ``config.silence_auto_apply()`` (env truthy, env
   ausente+cloud, env ausente+local).
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
    """Parte de un entorno determinista: sin flag de auto-apply ni modo cloud."""
    monkeypatch.delenv("VSE_SILENCE_AUTO_APPLY", raising=False)
    monkeypatch.delenv("EDIT_MODE", raising=False)


def _cmd_ok(args: Sequence[str], timeout: Optional[float] = None) -> ResultadoComando:
    """Ejecutor de comandos doble: siempre éxito (no invoca binarios reales)."""
    return ResultadoComando(returncode=0, stdout="1.0", stderr="", args=list(args))


class _Dobles:
    """Dobles inyectables de TODOS los pasos del pipeline (fase inicial + reanudación).

    Registra el orden de los pasos en ``llamadas`` y captura los tramos con los
    que se invocó la aplicación del corte (``tramos_aplicados``), para verificar
    que el auto-aplicado usa exactamente los silencios detectados.
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
        return [Palabra(texto="hola", inicio_s=0.0, fin_s=0.5)]

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
# (1) Auto-apply activado → NO pausa en silencios; continúa el pipeline
# ===========================================================================
def test_auto_apply_por_flag_no_pausa_y_aplica_tramos(monkeypatch) -> None:
    """Con ``VSE_SILENCE_AUTO_APPLY=1`` el job con silencios NO queda en
    ESPERANDO_EDICION_SILENCIOS: se auto-aplican los tramos detectados y el
    pipeline continúa hasta la siguiente pausa (edición final, revisar=False)."""
    monkeypatch.setenv("VSE_SILENCE_AUTO_APPLY", "1")
    manager = JobManager()
    dobles = _Dobles(silencios=[(1.0, 2.0), (4.0, 5.5)], duracion=10.0)
    runner = _runner(manager, dobles)

    manager.crear_job(
        "job-auto", ["c1"], _ajustes(silencios_activado=True, revisar=False), workdir="wd"
    )

    resultado = runner.ejecutar_job("job-auto")

    # NO se quedó en la pausa manual de silencios: continuó a la edición final.
    assert resultado.pendiente_edicion_silencios is False
    assert resultado.pendiente_eleccion_render is True
    estado = manager.obtener("job-auto").progreso.estado
    assert estado == JobStatus.ESPERANDO_EDICION_FINAL
    assert estado != JobStatus.ESPERANDO_EDICION_SILENCIOS

    # Se aplicó el corte con EXACTAMENTE los tramos detectados y se transcribió.
    # El auto-aplicado continúa el flujo hasta la SIGUIENTE pausa (edición final);
    # el render (REMOTION/PRESERVAR) recién ocurre en reanudar_render_job.
    assert dobles.tramos_aplicados == [(1.0, 2.0), (4.0, 5.5)]
    assert dobles.llamadas == [
        "UNIR",
        "DETECTAR",
        "APLICAR",
        "TRANSCRIBIR",
    ]
    assert "REMOTION" not in dobles.llamadas


def test_auto_apply_por_cloud_mode_no_pausa(monkeypatch) -> None:
    """Sin el flag pero en modo cloud (``EDIT_MODE=cloud``), también auto-aplica
    (default cloud) y NO queda en ESPERANDO_EDICION_SILENCIOS."""
    monkeypatch.setenv("EDIT_MODE", "cloud")
    manager = JobManager()
    dobles = _Dobles(silencios=[(2.0, 3.0)], duracion=8.0)
    runner = _runner(manager, dobles)

    manager.crear_job(
        "job-cloud", ["c1"], _ajustes(silencios_activado=True, revisar=True), workdir="wd"
    )

    resultado = runner.ejecutar_job("job-cloud")

    # Con revisar=True la siguiente pausa es la revisión de subtítulos.
    assert resultado.pendiente_edicion_silencios is False
    assert manager.obtener("job-cloud").progreso.estado == JobStatus.ESPERANDO_REVISION
    assert dobles.tramos_aplicados == [(2.0, 3.0)]
    assert "APLICAR" in dobles.llamadas and "TRANSCRIBIR" in dobles.llamadas


# ===========================================================================
# (2) Auto-apply desactivado (local, sin env) → se conserva la pausa manual
# ===========================================================================
def test_sin_flag_local_conserva_pausa_manual(monkeypatch) -> None:
    """Sin la env y en modo local (default) se conserva el comportamiento
    histórico: el job queda pausado en ESPERANDO_EDICION_SILENCIOS y NO se aplica
    el corte automáticamente."""
    # _entorno_limpio ya garantiza que no hay flag ni EDIT_MODE=cloud.
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
    # NO se auto-aplicó el corte ni se avanzó a TRANSCRIBIR.
    assert dobles.tramos_aplicados is None
    assert "APLICAR" not in dobles.llamadas
    assert "TRANSCRIBIR" not in dobles.llamadas


# ===========================================================================
# (3) Unit del helper config.silence_auto_apply()
# ===========================================================================
def test_silence_auto_apply_env_truthy(monkeypatch) -> None:
    """La env truthy fuerza auto-apply=True aun en modo local."""
    monkeypatch.delenv("EDIT_MODE", raising=False)  # local
    for valor in ("1", "true", "TRUE", "yes", "Yes"):
        monkeypatch.setenv("VSE_SILENCE_AUTO_APPLY", valor)
        assert config.silence_auto_apply() is True, valor


def test_silence_auto_apply_env_falsy(monkeypatch) -> None:
    """La env con un valor explícito no-truthy fuerza auto-apply=False aun en cloud."""
    monkeypatch.setenv("EDIT_MODE", "cloud")
    for valor in ("0", "false", "no", "off"):
        monkeypatch.setenv("VSE_SILENCE_AUTO_APPLY", valor)
        assert config.silence_auto_apply() is False, valor


def test_silence_auto_apply_env_ausente_cloud(monkeypatch) -> None:
    """Sin la env, en modo cloud el default es auto-apply=True."""
    monkeypatch.delenv("VSE_SILENCE_AUTO_APPLY", raising=False)
    monkeypatch.setenv("EDIT_MODE", "cloud")
    assert config.silence_auto_apply() is True


def test_silence_auto_apply_env_ausente_local(monkeypatch) -> None:
    """Sin la env, en modo local el default es auto-apply=False (pausa manual)."""
    monkeypatch.delenv("VSE_SILENCE_AUTO_APPLY", raising=False)
    monkeypatch.delenv("EDIT_MODE", raising=False)
    assert config.silence_auto_apply() is False
