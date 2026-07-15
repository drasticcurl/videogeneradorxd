"""Pruebas de transiciones de estado y pausas del pipeline extendido (Tarea 4.4).

Feature: ``edicion-avanzada-shorts``. Verifican, con **pasos inyectables**
(dobles) y **sin binarios reales** (ffmpeg/whisper/Node), las garantías del
orden del flujo y de las tres pausas del pipeline:

* **Orden del flujo y TRES pausas (Req 16.1):** un Job recorre, en orden
  estricto, ``EN_EJECUCION → ESPERANDO_EDICION_SILENCIOS`` (tras la detección de
  silencios, con silencios activados), al reanudar con los tramos editados
  ``→ ESPERANDO_REVISION`` o ``ESPERANDO_EDICION_FINAL`` según los ajustes, y
  finalmente ``ESPERANDO_EDICION_FINAL → COMPLETADO`` tras el render.
* **Persistencia del workdir entre pausas (Req 16.2):** el directorio de trabajo
  y sus artefactos NO se limpian mientras el Job está en pausa (``cleanup`` no se
  invoca y los artefactos persisten).
* **Monotonía del progreso (Req 16.4):** el porcentaje reportado por el Gestor
  nunca decrece a lo largo del flujo completo con pausas y se mantiene en
  ``[0, 100]``.
* **Parada en fallo sin avanzar (Req 16.6):** si un paso falla (p. ej. la
  aplicación del corte de silencios), el Job pasa a ``FALLIDO`` en ese paso y no
  ejecuta ningún paso posterior.
* **Silencios desactivados (Req 1.5):** sin corte de silencios NO hay pausa de
  edición de silencios y el pipeline continúa directamente a TRANSCRIBIR.

Los pasos del pipeline se sustituyen por dobles inyectados a través del
``JobRunner``. Como :func:`app.engine.pipeline.ejecutar_pipeline` no acepta los
pasos de la reanudación (``fn_aplicar``, ``fn_remotion``), se usan DOS runners
que **comparten el mismo Gestor de Jobs** (fuente de verdad del estado): uno con
los pasos de la fase inicial (para ``ejecutar_job``) y otro que añade los pasos
de las reanudaciones. Esto evita depender de binarios reales en cualquier fase.

Validates: Requirements 16.1, 16.2, 16.4, 16.6 (y 1.5).
"""

from __future__ import annotations

from pathlib import Path
from typing import List, Optional, Sequence, Tuple

import pytest

from app import config
from app.engine.proc import ResultadoComando
from app.engine.silence import ResultadoDeteccionSilencios, SilenceProcessingError
from app.jobs.manager import JobManager
from app.jobs.runner import JobRunner
from app.models.job import JobStatus
from app.models.settings import Ajustes, Palabra, TextoExtra
from app.storage.workdir import JobWorkdir


# ===========================================================================
# Fixtures e infraestructura común
# ===========================================================================
@pytest.fixture(autouse=True)
def _aislar_workdir(tmp_path, monkeypatch):
    """Aísla ``WORKDIR_ROOT``/``OUTPUT_ROOT`` en un directorio temporal por test."""
    monkeypatch.setattr(config, "WORKDIR_ROOT", tmp_path / "work")
    monkeypatch.setattr(config, "OUTPUT_ROOT", tmp_path / "out")


def _cmd_ok(args: Sequence[str], timeout: Optional[float] = None) -> ResultadoComando:
    """Ejecutor de comandos doble: siempre éxito (no invoca binarios reales)."""
    return ResultadoComando(returncode=0, stdout="1.0", stderr="", args=list(args))


class _ManagerGrabador(JobManager):
    """Gestor de Jobs que graba el porcentaje almacenado tras cada actualización.

    Sirve para verificar la monotonía del progreso (Req 16.4): tras cada evento
    de progreso se registra el porcentaje que el Gestor conserva (ya acotado y
    monótono no decreciente por diseño).
    """

    def __init__(self) -> None:
        super().__init__()
        self.historial_pct: List[int] = []

    def actualizar_progreso(self, job_id: str, **kwargs):  # noqa: ANN003
        job = super().actualizar_progreso(job_id, **kwargs)
        self.historial_pct.append(job.progreso.porcentaje)
        return job


class _Dobles:
    """Conjunto de dobles inyectables de los pasos del pipeline.

    Registra en ``llamadas`` el nombre de cada paso ejecutado, en orden, para
    poder verificar el orden del flujo y la NO ejecución de pasos posteriores a
    un fallo. Escribe artefactos reales (pequeños) en el workdir para verificar
    la persistencia entre pausas (Req 16.2).
    """

    def __init__(
        self,
        silencios: Sequence[Tuple[float, float]],
        duracion: float,
        *,
        fallo_aplicar: bool = False,
    ) -> None:
        self.silencios = list(silencios)
        self.duracion = duracion
        self.fallo_aplicar = fallo_aplicar
        self.llamadas: List[str] = []

    # --- Fase inicial (ejecutar_pipeline) --------------------------------
    def fn_unir(self, job: JobWorkdir, orden, ancho, alto, fps, **kw) -> Path:  # noqa: ANN001
        self.llamadas.append("UNIR")
        ruta = job.resolve("unido.mp4")
        ruta.write_bytes(b"unido")  # artefacto real para verificar persistencia
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

    # --- Fase de reanudación --------------------------------------------
    def fn_aplicar(self, entrada, salida, tramos, duracion, *, runner=None, **kw) -> Path:  # noqa: ANN001
        self.llamadas.append("APLICAR")
        if self.fallo_aplicar:
            raise SilenceProcessingError("recorte de silencios falló (simulado)")
        Path(salida).write_bytes(b"cortado")  # artefacto real (vídeo cortado)
        return Path(salida)

    def fn_remotion(self, entrada, grupos, sub, res, fps, props, salida, **kw) -> Path:  # noqa: ANN001
        self.llamadas.append("REMOTION")
        return Path(salida)

    # --- Empaquetado de inyecciones -------------------------------------
    def inyecciones_fase1(self) -> dict:
        """Inyecciones válidas para ``ejecutar_pipeline`` (fase inicial)."""
        return dict(
            fn_unir=self.fn_unir,
            fn_detectar=self.fn_detectar,
            fn_transcribir=self.fn_transcribir,
            fn_subtitulos=self.fn_subtitulos,
            fn_musica=self.fn_musica,
            fn_preservar=self.fn_preservar,
        )

    def inyecciones_reanudacion(self) -> dict:
        """Inyecciones para las reanudaciones (añade ``fn_aplicar`` y ``fn_remotion``)."""
        d = self.inyecciones_fase1()
        d.update(fn_aplicar=self.fn_aplicar, fn_remotion=self.fn_remotion)
        return d


def _ajustes(*, silencios_activado: bool, revisar: bool) -> Ajustes:
    """Construye ``Ajustes`` con el corte de silencios y la revisión configurados."""
    ajustes = Ajustes()
    ajustes.silencios.activado = silencios_activado
    ajustes.subtitulos.revisar = revisar
    return ajustes


def _espiar_cleanup(monkeypatch) -> dict:
    """Instrumenta ``JobWorkdir.cleanup`` para contar sus invocaciones.

    Devuelve un dict con la clave ``n`` (número de llamadas). Se conserva el
    comportamiento real (se envuelve la implementación original).
    """
    contador = {"n": 0}
    cleanup_real = JobWorkdir.cleanup

    def _spy(self, *a, **k):  # noqa: ANN001
        contador["n"] += 1
        return cleanup_real(self, *a, **k)

    monkeypatch.setattr(JobWorkdir, "cleanup", _spy)
    return contador


def _crear_runners(
    manager: JobManager, dobles: _Dobles
) -> Tuple[JobRunner, JobRunner]:
    """Crea dos runners que comparten el ``manager`` (inicial + reanudación).

    El runner inicial sólo lleva los pasos válidos para ``ejecutar_pipeline``; el
    de reanudación añade ``fn_aplicar`` y ``fn_remotion`` (ignorados por
    ``ejecutar_pipeline`` pero usados por las reanudaciones).
    """
    inicial = JobRunner(manager, runner=_cmd_ok, **dobles.inyecciones_fase1())
    reanuda = JobRunner(manager, runner=_cmd_ok, **dobles.inyecciones_reanudacion())
    return inicial, reanuda


# ===========================================================================
# Req 16.1 — Orden del flujo y las tres pausas
# ===========================================================================
def test_flujo_completo_recorre_las_tres_pausas_con_revision(monkeypatch) -> None:
    """Con silencios y revisión activados, el Job recorre las TRES pausas en orden
    y termina COMPLETADO (Req 16.1)."""
    contador_cleanup = _espiar_cleanup(monkeypatch)
    manager = JobManager()
    dobles = _Dobles(silencios=[(1.0, 2.0)], duracion=10.0)
    inicial, reanuda = _crear_runners(manager, dobles)

    manager.crear_job("job-flujo", ["c1"], _ajustes(silencios_activado=True, revisar=True), workdir="wd")

    # (1) EN_EJECUCION → ESPERANDO_EDICION_SILENCIOS tras la detección.
    r1 = inicial.ejecutar_job("job-flujo")
    assert r1.pendiente_edicion_silencios is True
    estado = manager.obtener("job-flujo").progreso.estado
    assert estado == JobStatus.ESPERANDO_EDICION_SILENCIOS
    # Artefactos persistidos para la edición del timeline (Req 1.3).
    js = manager.obtener("job-flujo")
    assert js.unido_path is not None and js.unido_path.endswith("unido.mp4")
    assert js.duracion_unido_s == 10.0
    # El workdir NO se limpió durante la pausa (Req 16.2).
    assert contador_cleanup["n"] == 0
    assert JobWorkdir("job-flujo").resolve("unido.mp4").exists()

    # (2) Reanudar con tramos editados → ESPERANDO_REVISION (revisar=True).
    r2 = reanuda.reanudar_silencios_job("job-flujo", [(1.0, 2.0)])
    assert r2.pendiente_revision is True
    assert manager.obtener("job-flujo").progreso.estado == JobStatus.ESPERANDO_REVISION
    assert "APLICAR" in dobles.llamadas and "TRANSCRIBIR" in dobles.llamadas
    # Persistencia entre pausas: unido y cortado siguen en disco; sin cleanup.
    assert contador_cleanup["n"] == 0
    assert JobWorkdir("job-flujo").resolve("unido.mp4").exists()
    assert JobWorkdir("job-flujo").resolve("cortado.mp4").exists()

    # (3) Reanudar la revisión → ESPERANDO_EDICION_FINAL.
    r3 = reanuda.reanudar_job("job-flujo", r2.grupos)
    assert r3.pendiente_eleccion_render is True
    assert manager.obtener("job-flujo").progreso.estado == JobStatus.ESPERANDO_EDICION_FINAL
    assert contador_cleanup["n"] == 0

    # (4) ESPERANDO_EDICION_FINAL → COMPLETADO tras el render (siempre Remotion).
    r4 = reanuda.reanudar_render_job("job-flujo")
    assert r4.exito is True
    assert manager.obtener("job-flujo").progreso.estado == JobStatus.COMPLETADO
    assert manager.obtener("job-flujo").progreso.porcentaje == 100
    # El render usó Remotion (nunca el quemado ASS en este flujo).
    assert "REMOTION" in dobles.llamadas
    assert "SUBTITULOS_ASS" not in dobles.llamadas


def test_reanudar_silencios_va_a_edicion_final_sin_revision(monkeypatch) -> None:
    """Sin revisión de subtítulos, al reanudar los silencios el Job pasa
    directamente a ESPERANDO_EDICION_FINAL (Req 16.1)."""
    _espiar_cleanup(monkeypatch)
    manager = JobManager()
    dobles = _Dobles(silencios=[], duracion=5.0)  # sin silencios detectados (Req 1.4)
    inicial, reanuda = _crear_runners(manager, dobles)

    manager.crear_job("job-sinrev", ["c1"], _ajustes(silencios_activado=True, revisar=False), workdir="wd")

    r1 = inicial.ejecutar_job("job-sinrev")
    assert r1.pendiente_edicion_silencios is True
    assert manager.obtener("job-sinrev").progreso.estado == JobStatus.ESPERANDO_EDICION_SILENCIOS

    r2 = reanuda.reanudar_silencios_job("job-sinrev", [])
    # Sin revisión: se salta ESPERANDO_REVISION y se pausa en la edición final.
    assert r2.pendiente_revision is False
    assert r2.pendiente_eleccion_render is True
    assert manager.obtener("job-sinrev").progreso.estado == JobStatus.ESPERANDO_EDICION_FINAL


def test_render_final_con_textos_extra_completa(monkeypatch) -> None:
    """La edición final con textos extra persistidos reanuda y completa el render
    (Req 16.1), propagando los textos extra al render Remotion."""
    _espiar_cleanup(monkeypatch)
    manager = JobManager()
    dobles = _Dobles(silencios=[(2.0, 3.0)], duracion=8.0)
    inicial, reanuda = _crear_runners(manager, dobles)

    manager.crear_job("job-tx", ["c1"], _ajustes(silencios_activado=True, revisar=False), workdir="wd")
    inicial.ejecutar_job("job-tx")
    reanuda.reanudar_silencios_job("job-tx", [(2.0, 3.0)])
    assert manager.obtener("job-tx").progreso.estado == JobStatus.ESPERANDO_EDICION_FINAL

    # El usuario añade un texto extra en la edición final (POST /render lo persiste).
    manager.guardar_textos_extra(
        "job-tx", [TextoExtra(texto="Hook", inicio_s=0.0, fin_s=2.0)]
    )
    resultado = reanuda.reanudar_render_job("job-tx")
    assert resultado.exito is True
    assert manager.obtener("job-tx").progreso.estado == JobStatus.COMPLETADO
    assert "REMOTION" in dobles.llamadas


# ===========================================================================
# Req 16.2 — Persistencia del workdir entre pausas
# ===========================================================================
def test_workdir_se_conserva_en_todas_las_pausas(monkeypatch) -> None:
    """El ``cleanup`` NO se invoca en ninguna de las tres pausas y los artefactos
    persisten desde el inicio de cada pausa hasta la reanudación (Req 16.2)."""
    contador_cleanup = _espiar_cleanup(monkeypatch)
    manager = JobManager()
    dobles = _Dobles(silencios=[(1.0, 2.0)], duracion=10.0)
    inicial, reanuda = _crear_runners(manager, dobles)

    manager.crear_job("job-wd", ["c1"], _ajustes(silencios_activado=True, revisar=True), workdir="wd")

    inicial.ejecutar_job("job-wd")
    assert contador_cleanup["n"] == 0
    assert JobWorkdir("job-wd").root.exists()

    reanuda.reanudar_silencios_job("job-wd", [(1.0, 2.0)])
    assert contador_cleanup["n"] == 0
    assert JobWorkdir("job-wd").root.exists()

    grupos = manager.obtener("job-wd").grupos_subtitulos
    reanuda.reanudar_job("job-wd", grupos)
    assert contador_cleanup["n"] == 0
    assert JobWorkdir("job-wd").root.exists()
    # Los artefactos intermedios permanecen idénticos hasta la reanudación final.
    assert JobWorkdir("job-wd").resolve("unido.mp4").read_bytes() == b"unido"
    assert JobWorkdir("job-wd").resolve("cortado.mp4").read_bytes() == b"cortado"


# ===========================================================================
# Req 16.4 — Monotonía del progreso a lo largo del flujo completo
# ===========================================================================
def test_progreso_monotono_a_lo_largo_del_flujo_completo(monkeypatch) -> None:
    """El porcentaje reportado por el Gestor nunca decrece y se mantiene en
    ``[0, 100]`` a lo largo del flujo completo con las tres pausas (Req 16.4)."""
    _espiar_cleanup(monkeypatch)
    manager = _ManagerGrabador()
    dobles = _Dobles(silencios=[(1.0, 2.0)], duracion=10.0)
    inicial, reanuda = _crear_runners(manager, dobles)

    manager.crear_job("job-mono", ["c1"], _ajustes(silencios_activado=True, revisar=True), workdir="wd")

    inicial.ejecutar_job("job-mono")
    reanuda.reanudar_silencios_job("job-mono", [(1.0, 2.0)])
    grupos = manager.obtener("job-mono").grupos_subtitulos
    reanuda.reanudar_job("job-mono", grupos)
    reanuda.reanudar_render_job("job-mono")

    historial = manager.historial_pct
    assert historial, "se esperaba al menos un evento de progreso"
    # Rango [0, 100] en cada actualización.
    assert all(0 <= p <= 100 for p in historial)
    # Monotonía no decreciente a lo largo de TODO el flujo (con pausas).
    for anterior, actual in zip(historial, historial[1:]):
        assert actual >= anterior, "el porcentaje reportado decreció"
    # El flujo termina en 100 % (Req 16.5).
    assert historial[-1] == 100


# ===========================================================================
# Req 16.6 — Parada en fallo sin avanzar
# ===========================================================================
def test_fallo_al_aplicar_corte_detiene_en_ese_paso(monkeypatch) -> None:
    """Si la aplicación del corte de silencios falla, el Job pasa a FALLIDO en
    CORTAR_SILENCIOS y NO ejecuta pasos posteriores (Req 16.6)."""
    _espiar_cleanup(monkeypatch)
    manager = JobManager()
    dobles = _Dobles(silencios=[(1.0, 2.0)], duracion=10.0, fallo_aplicar=True)
    inicial, reanuda = _crear_runners(manager, dobles)

    manager.crear_job("job-fallo", ["c1"], _ajustes(silencios_activado=True, revisar=True), workdir="wd")

    inicial.ejecutar_job("job-fallo")
    assert manager.obtener("job-fallo").progreso.estado == JobStatus.ESPERANDO_EDICION_SILENCIOS

    resultado = reanuda.reanudar_silencios_job("job-fallo", [(1.0, 2.0)])
    assert resultado.exito is False
    assert resultado.paso_fallido is not None and resultado.paso_fallido.value == "CORTAR_SILENCIOS"

    prog = manager.obtener("job-fallo").progreso
    assert prog.estado == JobStatus.FALLIDO
    assert prog.error is not None
    assert prog.error["paso"] == "CORTAR_SILENCIOS"
    assert prog.error["motivo"]
    # Se intentó aplicar el corte pero NO se avanzó a TRANSCRIBIR ni más allá.
    assert "APLICAR" in dobles.llamadas
    assert "TRANSCRIBIR" not in dobles.llamadas
    assert "REMOTION" not in dobles.llamadas


# ===========================================================================
# Req 1.5 — Silencios desactivados: sin pausa de silencios, se continúa a TRANSCRIBIR
# ===========================================================================
def test_silencios_desactivados_no_pausa_y_continua_a_transcribir(monkeypatch) -> None:
    """Con el corte de silencios desactivado NO hay pausa de edición de silencios
    y el pipeline continúa a TRANSCRIBIR (Req 1.5)."""
    _espiar_cleanup(monkeypatch)
    manager = JobManager()
    dobles = _Dobles(silencios=[(1.0, 2.0)], duracion=10.0)
    inicial, _reanuda = _crear_runners(manager, dobles)

    manager.crear_job("job-nosil", ["c1"], _ajustes(silencios_activado=False, revisar=False), workdir="wd")

    r1 = inicial.ejecutar_job("job-nosil")
    # NO hay pausa de edición de silencios; se pausa directamente en edición final.
    assert r1.pendiente_edicion_silencios is False
    assert r1.pendiente_eleccion_render is True
    assert manager.obtener("job-nosil").progreso.estado == JobStatus.ESPERANDO_EDICION_FINAL
    # La detección de silencios NO se ejecutó; sí la transcripción (Req 1.5).
    assert "DETECTAR" not in dobles.llamadas
    assert "TRANSCRIBIR" in dobles.llamadas
