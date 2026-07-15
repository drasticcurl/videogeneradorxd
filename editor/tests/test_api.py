"""Tests de la orquestación del pipeline y el Gestor de Jobs (Tarea 12, Req 10).

Contiene los tests property-based (Hypothesis, >= 100 iteraciones) de las
Propiedades 22 y 23 del diseño, más tests unitarios de apoyo del Gestor de Jobs
(:class:`~app.jobs.manager.JobManager`), del pipeline
(:func:`~app.engine.pipeline.ejecutar_pipeline`) y del ejecutor en background
(:class:`~app.jobs.runner.JobRunner`):

* **Propiedad 22** (Feature: vertical-shorts-editor, Property 22): a lo largo de
  la ejecución de un Job, todo estado de progreso tiene el porcentaje en
  ``[0, 100]`` y el estado en el conjunto válido, y el porcentaje y el índice de
  paso son **monótonos no decrecientes**.
  **Validates: Requirements 10.3, 10.5**
* **Propiedad 23** (Feature: vertical-shorts-editor, Property 23): si un paso
  falla, el Job pasa a ``fallido``, **ningún paso posterior se ejecuta** y el
  progreso incluye ``error`` con ``paso`` + ``motivo``.
  **Validates: Requirements 10.7**

Los cinco pasos del pipeline se sustituyen por **dobles** (fakes) inyectados, de
modo que los tests no dependan de ffmpeg/auto-editor/faster-whisper ni de medios
reales.
"""

from __future__ import annotations

import asyncio
import shutil
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Dict, Iterator, List, Optional, Tuple

from hypothesis import given, settings
from hypothesis import strategies as st

from app import config
from app.engine.pipeline import (
    ORDEN_PASOS,
    ejecutar_pipeline,
    reanudar_desde_silencios,
    reanudar_pipeline,
)
from app.engine.proc import ResultadoComando
from app.engine.silence import ResultadoDeteccionSilencios, SilenceProcessingError
from app.jobs.manager import JobManager
from app.jobs.runner import JobRunner
from app.models.job import JobStatus, PipelineStep
from app.models.settings import Ajustes, AjustesMusica
from app.storage.workdir import JobWorkdir

# Mínimo 100 iteraciones por propiedad (aquí 150).
PBT = settings(max_examples=150, deadline=None)

# Conjunto válido de estados (Req 10.3, Propiedad 22).
ESTADOS_VALIDOS = {
    JobStatus.EN_COLA,
    JobStatus.EN_EJECUCION,
    JobStatus.COMPLETADO,
    JobStatus.FALLIDO,
}


@contextmanager
def isolated_config_dirs() -> Iterator[None]:
    """Aísla ``WORKDIR_ROOT``/``OUTPUT_ROOT`` en un directorio temporal único.

    Evita ensuciar el repositorio y fugas de estado entre ejemplos de Hypothesis.
    """
    old_work = config.WORKDIR_ROOT
    old_out = config.OUTPUT_ROOT
    base = Path(tempfile.mkdtemp(prefix="vse_pipeline_test_"))
    config.WORKDIR_ROOT = (base / "work").resolve()
    config.OUTPUT_ROOT = (base / "out").resolve()
    try:
        yield
    finally:
        config.WORKDIR_ROOT = old_work
        config.OUTPUT_ROOT = old_out
        shutil.rmtree(base, ignore_errors=True)


# ---------------------------------------------------------------------------
# Dobles (fakes) de los cinco pasos del pipeline
# ---------------------------------------------------------------------------
def _construir_fakes(
    recorder: List[str], fallo_en: Optional[int] = None
) -> Dict[str, object]:
    """Construye dobles de los cinco pasos que registran su ejecución en orden.

    Cada paso añade su nombre a ``recorder`` al ejecutarse; si su índice coincide
    con ``fallo_en``, lanza una excepción para simular el fallo del paso. Los
    dobles devuelven rutas dentro del workdir sin invocar herramientas externas.
    """

    def _marcar(indice: int, nombre: str) -> None:
        recorder.append(nombre)
        if fallo_en == indice:
            raise RuntimeError(f"fallo simulado en {nombre}")

    def fn_unir(job: JobWorkdir, orden, ancho, alto, fps, **kw) -> Path:  # noqa: ANN001
        _marcar(0, PipelineStep.UNIR.value)
        return job.resolve("unido.mp4")

    def fn_detectar(entrada, *, umbral_db, margen_ms, modo="db", runner=None, **kw):  # noqa: ANN001
        # Detección de silencios (FASE A del paso CORTAR_SILENCIOS, spec
        # edicion-avanzada-shorts): registra el paso CORTAR_SILENCIOS y devuelve
        # una detección vacía (sin silencios) sin invocar ffmpeg. La aplicación
        # del corte (FASE B) NO vuelve a registrar el paso para no duplicarlo.
        _marcar(1, PipelineStep.CORTAR_SILENCIOS.value)
        return ResultadoDeteccionSilencios(silencios=[], duracion=1.0)

    def fn_cortar(entrada, salida, **kw) -> Path:  # noqa: ANN001
        # Conservado por compatibilidad de firma; ya NO se invoca en el nuevo
        # flujo (el corte se aplica al reanudar con ``fn_aplicar``).
        return Path(salida)

    def fn_transcribir(entrada, ajustes_t, audio, **kw) -> List:  # noqa: ANN001
        _marcar(2, PipelineStep.TRANSCRIBIR.value)
        return []

    def fn_subtitulos(entrada, palabras, sub, res, ass, salida, **kw) -> Path:  # noqa: ANN001
        _marcar(3, PipelineStep.SUBTITULOS.value)
        return Path(salida)

    def fn_musica(entrada, mwav, mus, salida, **kw) -> Path:  # noqa: ANN001
        _marcar(4, PipelineStep.MUSICA.value)
        return Path(salida)

    def fn_preservar(job: JobWorkdir, tmp) -> Path:  # noqa: ANN001
        # No copia archivos reales: basta con devolver la ruta de salida.
        return job.output_path

    return dict(
        fn_unir=fn_unir,
        fn_detectar=fn_detectar,
        fn_cortar=fn_cortar,
        fn_transcribir=fn_transcribir,
        fn_subtitulos=fn_subtitulos,
        fn_musica=fn_musica,
        fn_preservar=fn_preservar,
    )


def _cmd_ok(args, timeout=None) -> ResultadoComando:  # noqa: ANN001
    """Ejecutor de comandos doble: siempre éxito (evita ffmpeg real al aplicar el corte)."""
    return ResultadoComando(returncode=0, stdout="1.0", stderr="", args=list(args))


def _fake_aplicar(entrada, salida, tramos, duracion, *, runner=None, **kw) -> Path:  # noqa: ANN001
    """Doble de la aplicación del corte de silencios (FASE B). No registra paso
    (la etapa CORTAR_SILENCIOS ya la registró la detección)."""
    return Path(salida)


def _flujo_completo(job_wd, orden, ajustes, fakes, *, reporter=None, musica_wav=None):  # noqa: ANN001
    """Recorre el pipeline completo con las pausas del nuevo flujo (edicion-avanzada-shorts).

    Encadena ``ejecutar_pipeline`` → (pausa de silencios) ``reanudar_desde_silencios``
    → (pausa de edición final) ``reanudar_pipeline`` con motor ``"ass"``,
    reutilizando los dobles inyectados. Si un paso falla en cualquier fase, la
    función devuelve el ``ResultadoPipeline`` fallido sin avanzar (las pausas no
    llegan a alcanzarse).
    """
    kw = {} if reporter is None else {"reporter": reporter}
    r = ejecutar_pipeline(job_wd, orden, ajustes, musica_wav=musica_wav, **kw, **fakes)
    if r.pendiente_edicion_silencios:
        r = reanudar_desde_silencios(
            job_wd, r.unido, [], r.duracion_unido_s, ajustes,
            fn_aplicar=_fake_aplicar, **kw, **fakes,
        )
    if r.pendiente_eleccion_render:
        r = reanudar_pipeline(
            job_wd, r.cortado, ajustes, grupos=r.grupos, motor="ass",
            musica_wav=musica_wav, **kw, **fakes,
        )
    return r


class _ReporterAlGestor:
    """Reporter que canaliza los eventos al Gestor y toma una instantánea tras cada uno."""

    def __init__(self, manager: JobManager, job_id: str) -> None:
        self.manager = manager
        self.job_id = job_id
        self.snapshots: List[Tuple[JobStatus, int, int]] = []

    def __call__(self, evento) -> None:  # noqa: ANN001
        self.manager.actualizar_progreso(
            self.job_id,
            estado=evento.estado,
            indice_paso=evento.indice_paso,
            paso_actual=evento.paso_actual,
            porcentaje=evento.porcentaje,
            mensaje=evento.mensaje,
            error=evento.error,
        )
        prog = self.manager.obtener(self.job_id).progreso
        self.snapshots.append((prog.estado, prog.indice_paso, prog.porcentaje))


def _ajustes_con_musica() -> Ajustes:
    """Ajustes por defecto (todos válidos) incluyendo la sección de música."""
    return Ajustes(musica=AjustesMusica())


_ORDEN_CLIPS = st.lists(
    st.text(
        alphabet=st.characters(whitelist_categories=("L", "N"), whitelist_characters="_-"),
        min_size=1,
        max_size=8,
    ),
    min_size=1,
    max_size=6,
)


# ---------------------------------------------------------------------------
# Propiedad 22: Invariantes de progreso (rango y monotonicidad)
# Feature: vertical-shorts-editor, Property 22
# Validates: Requirements 10.3, 10.5
# ---------------------------------------------------------------------------
@PBT
@given(
    orden_clips=_ORDEN_CLIPS,
    con_musica=st.booleans(),
    fallo_en=st.one_of(st.none(), st.integers(min_value=0, max_value=4)),
)
def test_propiedad_22_invariantes_de_progreso(
    orden_clips: List[str], con_musica: bool, fallo_en: Optional[int]
) -> None:
    """Todo estado de progreso reportado tiene porcentaje en [0,100] y estado
    válido, y el porcentaje e índice de paso son monótonos no decrecientes a lo
    largo del Job (Req 10.3, 10.5)."""
    with isolated_config_dirs():
        manager = JobManager()
        job_id = "job-p22"
        ajustes = _ajustes_con_musica()
        job_state = manager.crear_job(job_id, orden_clips, ajustes, workdir="wd")

        # Estado inicial (en_cola) también debe satisfacer los invariantes.
        reporter = _ReporterAlGestor(manager, job_id)
        prog0 = job_state.progreso
        reporter.snapshots.append((prog0.estado, prog0.indice_paso, prog0.porcentaje))

        manager.marcar_en_ejecucion(job_id)

        fakes = _construir_fakes(recorder=[], fallo_en=fallo_en)
        job_wd = JobWorkdir(job_id)
        musica_wav = "musica.wav" if con_musica else None

        ejecutar_pipeline(
            job_wd,
            orden_clips,
            ajustes,
            musica_wav=musica_wav,
            reporter=reporter,
            **fakes,
        )

        # (1) Rango y conjunto válido en cada instantánea.
        for estado, indice, pct in reporter.snapshots:
            assert 0 <= pct <= 100
            assert estado in ESTADOS_VALIDOS
            assert 0 <= indice <= job_state.progreso.total_pasos

        # (2) Monotonicidad no decreciente del porcentaje y del índice de paso.
        for (_, i_prev, p_prev), (_, i_cur, p_cur) in zip(
            reporter.snapshots, reporter.snapshots[1:]
        ):
            assert p_cur >= p_prev, "el porcentaje retrocedió"
            assert i_cur >= i_prev, "el índice de paso retrocedió"

        # El estado final del Gestor es fuente de verdad y es válido.
        assert manager.obtener(job_id).progreso.estado in ESTADOS_VALIDOS


# ---------------------------------------------------------------------------
# Propiedad 23: El fallo de un paso detiene el pipeline
# Feature: vertical-shorts-editor, Property 23
# Validates: Requirements 10.7
# ---------------------------------------------------------------------------
@PBT
@given(
    orden_clips=_ORDEN_CLIPS,
    fallo_en=st.integers(min_value=0, max_value=4),
)
def test_propiedad_23_fallo_detiene_pipeline(
    orden_clips: List[str], fallo_en: int
) -> None:
    """Si el paso de índice ``fallo_en`` falla, el Job pasa a ``fallido``, ningún
    paso posterior se ejecuta y el progreso incluye ``error`` con paso + motivo
    (Req 10.7)."""
    with isolated_config_dirs():
        manager = JobManager()
        job_id = "job-p23"
        ajustes = _ajustes_con_musica()
        manager.crear_job(job_id, orden_clips, ajustes, workdir="wd")
        manager.marcar_en_ejecucion(job_id)

        reporter = _ReporterAlGestor(manager, job_id)
        recorder: List[str] = []
        # Se incluye música para que los cinco pasos estén disponibles.
        fakes = _construir_fakes(recorder=recorder, fallo_en=fallo_en)
        job_wd = JobWorkdir(job_id)

        # El flujo se reparte en tres fases con pausas (spec edicion-avanzada-shorts):
        # detección de silencios (FASE A) → pausa → aplicación + transcripción →
        # pausa de edición final → render (motor "ass"). El ayudante recorre las
        # pausas necesarias; cuando el fallo inyectado ocurre en una fase, el flujo
        # se detiene ahí sin avanzar, verificándose el fail-stop completo (Req 10.7).
        resultado = _flujo_completo(
            job_wd, orden_clips, ajustes, fakes,
            reporter=reporter, musica_wav="musica.wav",
        )

        paso_fallido = ORDEN_PASOS[fallo_en]
        pasos_esperados = [p.value for p in ORDEN_PASOS[: fallo_en + 1]]

        # El pipeline no tuvo éxito y reporta el paso fallido.
        assert resultado.exito is False
        assert resultado.paso_fallido == paso_fallido

        # Se ejecutaron exactamente los pasos hasta el fallido (inclusive) y
        # NINGÚN paso posterior.
        assert recorder == pasos_esperados

        # El Job quedó en estado fallido con error {paso, motivo} (Req 10.7).
        prog = manager.obtener(job_id).progreso
        assert prog.estado == JobStatus.FALLIDO
        assert prog.error is not None
        assert prog.error["paso"] == paso_fallido.value
        assert prog.error["motivo"]
        assert paso_fallido.value in prog.error["motivo"] or "fallo" in prog.error["motivo"]


# ---------------------------------------------------------------------------
# Tests unitarios del Gestor de Jobs (Req 10.3, 10.5)
# ---------------------------------------------------------------------------
def test_manager_ciclo_de_vida() -> None:
    manager = JobManager()
    ajustes = _ajustes_con_musica()
    job = manager.crear_job("j1", ["a", "b"], ajustes, workdir="wd")
    assert job.progreso.estado == JobStatus.EN_COLA
    assert manager.existe("j1")

    manager.marcar_en_ejecucion("j1")
    assert manager.obtener("j1").progreso.estado == JobStatus.EN_EJECUCION

    manager.marcar_completado("j1", ruta_video_final="/out/j1/final.mp4")
    prog = manager.obtener("j1").progreso
    assert prog.estado == JobStatus.COMPLETADO
    assert prog.porcentaje == 100
    assert manager.obtener("j1").ruta_video_final == "/out/j1/final.mp4"


def test_manager_progreso_es_monotono() -> None:
    """El porcentaje y el índice nunca retroceden aunque se reporten valores
    menores (Req 10.5)."""
    manager = JobManager()
    manager.crear_job("j2", ["a"], _ajustes_con_musica(), workdir="wd")

    manager.actualizar_progreso(
        "j2", estado=JobStatus.EN_EJECUCION, indice_paso=3,
        paso_actual=PipelineStep.TRANSCRIBIR, porcentaje=70, mensaje="x",
    )
    # Intento de retroceso: se ignora, se conserva el máximo alcanzado.
    manager.actualizar_progreso(
        "j2", estado=JobStatus.EN_EJECUCION, indice_paso=1,
        paso_actual=PipelineStep.UNIR, porcentaje=10, mensaje="y",
    )
    prog = manager.obtener("j2").progreso
    assert prog.porcentaje == 70
    assert prog.indice_paso == 3


def test_manager_acota_porcentaje() -> None:
    manager = JobManager()
    manager.crear_job("j3", ["a"], _ajustes_con_musica(), workdir="wd")
    manager.actualizar_progreso(
        "j3", estado=JobStatus.EN_EJECUCION, indice_paso=1,
        paso_actual=PipelineStep.UNIR, porcentaje=250, mensaje="x",
    )
    assert manager.obtener("j3").progreso.porcentaje == 100


def test_manager_no_duplica_job() -> None:
    manager = JobManager()
    manager.crear_job("j4", ["a"], _ajustes_con_musica(), workdir="wd")
    try:
        manager.crear_job("j4", ["b"], _ajustes_con_musica(), workdir="wd")
        raise AssertionError("Se esperaba ValueError por Job duplicado")
    except ValueError:
        pass


def test_manager_obtener_inexistente_devuelve_none() -> None:
    manager = JobManager()
    assert manager.obtener("no-existe") is None
    assert not manager.existe("no-existe")


# ---------------------------------------------------------------------------
# Tests unitarios del pipeline
# ---------------------------------------------------------------------------
def test_pipeline_exito_llega_a_100() -> None:
    with isolated_config_dirs():
        recorder: List[str] = []
        fakes = _construir_fakes(recorder=recorder, fallo_en=None)
        job_wd = JobWorkdir("job-ok")
        ajustes = _ajustes_con_musica()
        # Flujo completo con pausas (detección de silencios → edición final →
        # render "ass"); el ayudante recorre las tres fases (spec
        # edicion-avanzada-shorts).
        resultado = _flujo_completo(
            job_wd, ["a", "b"], ajustes, fakes, musica_wav="musica.wav",
        )
        assert resultado.exito is True
        assert resultado.ruta_video_final == job_wd.output_path
        # Los cinco pasos se ejecutaron en orden (a lo largo de las tres fases).
        assert recorder == [p.value for p in ORDEN_PASOS]


def test_pipeline_omite_musica_sin_wav() -> None:
    """Sin WAV de música, el paso 5 se omite (Req 8.3)."""
    with isolated_config_dirs():
        recorder: List[str] = []
        fakes = _construir_fakes(recorder=recorder, fallo_en=None)
        job_wd = JobWorkdir("job-nomus")
        ajustes = _ajustes_con_musica()
        resultado = _flujo_completo(job_wd, ["a"], ajustes, fakes, musica_wav=None)
        assert resultado.exito is True
        assert PipelineStep.MUSICA.value not in recorder
        assert recorder == [p.value for p in ORDEN_PASOS[:4]]


# ---------------------------------------------------------------------------
# Bugfix macOS "Killed: 9": fail-soft opcional del corte de silencios
# (VSE_SILENCE_FAILSOFT). Solo afecta al paso CORTAR_SILENCIOS.
# ---------------------------------------------------------------------------
def _fakes_con_deteccion_que_falla(recorder: List[str]) -> Dict[str, object]:
    """Como ``_construir_fakes`` pero con un ``fn_detectar`` que lanza
    :class:`SilenceProcessingError` (simula el fallo de la detección de silencios).

    En el nuevo flujo (spec edicion-avanzada-shorts) el paso CORTAR_SILENCIOS se
    parte en detección (FASE A) y aplicación (FASE B); el fail-soft
    (``VSE_SILENCE_FAILSOFT``) actúa sobre el fallo de la DETECCIÓN, que es la que
    puede reventar antes de la pausa.
    """
    fakes = _construir_fakes(recorder=recorder, fallo_en=None)

    def fn_detectar(entrada, *, umbral_db, margen_ms, modo="db", runner=None, **kw):  # noqa: ANN001
        recorder.append(PipelineStep.CORTAR_SILENCIOS.value)
        raise SilenceProcessingError(
            "auto-editor falló (código 247): sin salida de diagnóstico "
            "(el proceso terminó por señal 9 (SIGKILL))"
        )

    fakes["fn_detectar"] = fn_detectar
    return fakes


def test_failsoft_activo_continua_sin_recortar(monkeypatch) -> None:
    """Con VSE_SILENCE_FAILSOFT=1, si la detección de silencios falla el pipeline
    continúa (usando el vídeo unido) y ejecuta los pasos siguientes."""
    monkeypatch.setenv("VSE_SILENCE_FAILSOFT", "1")
    with isolated_config_dirs():
        recorder: List[str] = []
        fakes = _fakes_con_deteccion_que_falla(recorder)
        job_wd = JobWorkdir("job-failsoft-on")
        ajustes = _ajustes_con_musica()

        # La detección falla pero el fail-soft continúa SIN pausa de silencios;
        # tras la transcripción el pipeline se pausa en la edición final y el
        # render (motor "ass") completa el Job.
        resultado = _flujo_completo(
            job_wd, ["a", "b"], ajustes, fakes, musica_wav="musica.wav",
        )

        # El pipeline termina con éxito pese al fallo de la detección de silencios.
        assert resultado.exito is True
        assert resultado.ruta_video_final == job_wd.output_path
        # Se intentó la detección y, tras el fallo, se ejecutaron los siguientes.
        assert recorder == [p.value for p in ORDEN_PASOS]


def test_failsoft_inactivo_falla_como_siempre(monkeypatch) -> None:
    """Sin VSE_SILENCE_FAILSOFT (o "0"), el fallo de la detección de silencios
    marca el pipeline como fallido en CORTAR_SILENCIOS y no ejecuta posteriores."""
    monkeypatch.setenv("VSE_SILENCE_FAILSOFT", "0")
    with isolated_config_dirs():
        recorder: List[str] = []
        fakes = _fakes_con_deteccion_que_falla(recorder)
        job_wd = JobWorkdir("job-failsoft-off")

        resultado = ejecutar_pipeline(
            job_wd, ["a", "b"], _ajustes_con_musica(),
            musica_wav="musica.wav", **fakes,
        )

        # Comportamiento por defecto (Req 10.7): Job fallido en CORTAR_SILENCIOS.
        assert resultado.exito is False
        assert resultado.paso_fallido == PipelineStep.CORTAR_SILENCIOS
        # No se ejecutó ningún paso posterior a CORTAR_SILENCIOS.
        assert recorder == [
            PipelineStep.UNIR.value,
            PipelineStep.CORTAR_SILENCIOS.value,
        ]


def test_failsoft_ausente_falla_como_siempre(monkeypatch) -> None:
    """Sin la variable de entorno definida, el comportamiento es el por defecto
    (fallo del Job en CORTAR_SILENCIOS)."""
    monkeypatch.delenv("VSE_SILENCE_FAILSOFT", raising=False)
    with isolated_config_dirs():
        recorder: List[str] = []
        fakes = _fakes_con_deteccion_que_falla(recorder)
        job_wd = JobWorkdir("job-failsoft-ausente")

        resultado = ejecutar_pipeline(
            job_wd, ["a"], _ajustes_con_musica(), musica_wav=None, **fakes,
        )

        assert resultado.exito is False
        assert resultado.paso_fallido == PipelineStep.CORTAR_SILENCIOS


def test_pipeline_omite_musica_sin_ajustes() -> None:
    """Con ``ajustes.musica = None`` el paso 5 se omite aunque haya WAV."""
    with isolated_config_dirs():
        recorder: List[str] = []
        fakes = _construir_fakes(recorder=recorder, fallo_en=None)
        job_wd = JobWorkdir("job-nomus2")
        ajustes = Ajustes(musica=None)
        resultado = _flujo_completo(
            job_wd, ["a"], ajustes, fakes, musica_wav="musica.wav",
        )
        assert resultado.exito is True
        assert PipelineStep.MUSICA.value not in recorder


# ---------------------------------------------------------------------------
# Tests unitarios del ejecutor en background (Req 10.1, 13.4, 13.5)
# ---------------------------------------------------------------------------
def test_runner_ejecuta_y_limpia_en_exito() -> None:
    """El runner ejecuta el pipeline, marca completado y limpia el workdir."""
    with isolated_config_dirs():
        manager = JobManager()
        manager.crear_job("job-run", ["a", "b"], _ajustes_con_musica(), workdir="wd")
        fakes = _construir_fakes(recorder=[], fallo_en=None)
        # ``runner=_cmd_ok`` evita ffmpeg real al aplicar el corte de silencios.
        runner = JobRunner(manager, runner=_cmd_ok, **fakes)

        # Fase 1: el runner ejecuta hasta la pausa de edición de silencios (spec
        # edicion-avanzada-shorts) y NO limpia el workdir (Req 16.2).
        resultado = runner.ejecutar_job("job-run")
        assert resultado.pendiente_edicion_silencios is True
        assert (
            manager.obtener("job-run").progreso.estado
            == JobStatus.ESPERANDO_EDICION_SILENCIOS
        )
        assert JobWorkdir("job-run").root.exists()

        # Fase 2: al confirmar los tramos, se aplica el corte y el Job se pausa en
        # la edición final (sin limpiar el workdir, Req 16.2).
        resultado = runner.reanudar_silencios_job("job-run", [])
        assert resultado.pendiente_eleccion_render is True
        assert (
            manager.obtener("job-run").progreso.estado
            == JobStatus.ESPERANDO_EDICION_FINAL
        )
        assert JobWorkdir("job-run").root.exists()

        # Fase 3: el render (motor "ass" en este test) completa el Job y limpia (Req 13.4).
        resultado = runner.reanudar_render_job("job-run", "ass")
        assert resultado.exito is True
        prog = manager.obtener("job-run").progreso
        assert prog.estado == JobStatus.COMPLETADO
        assert prog.porcentaje == 100
        # El workdir temporal se limpió tras finalizar (Req 13.4).
        assert not JobWorkdir("job-run").root.exists()


def test_runner_marca_fallido_y_limpia() -> None:
    """Ante un fallo de paso, el runner marca el Job fallido y limpia (Req 13.5)."""
    with isolated_config_dirs():
        manager = JobManager()
        manager.crear_job("job-fail", ["a"], _ajustes_con_musica(), workdir="wd")
        fakes = _construir_fakes(recorder=[], fallo_en=0)  # falla UNIR
        runner = JobRunner(manager, **fakes)

        resultado = runner.ejecutar_job("job-fail")

        assert resultado.exito is False
        prog = manager.obtener("job-fail").progreso
        assert prog.estado == JobStatus.FALLIDO
        assert prog.error is not None
        assert prog.error["paso"] == PipelineStep.UNIR.value
        assert not JobWorkdir("job-fail").root.exists()


def test_runner_lanzar_en_background() -> None:
    """``lanzar`` programa la ejecución en el executor sin bloquear (Req 10.1)."""
    with isolated_config_dirs():
        manager = JobManager()
        manager.crear_job("job-bg", ["a"], _ajustes_con_musica(), workdir="wd")
        fakes = _construir_fakes(recorder=[], fallo_en=None)
        runner = JobRunner(manager, **fakes)

        async def _run():
            futuro = await runner.lanzar("job-bg")
            return await futuro

        # ``lanzar`` programa la ejecución en el executor; la fase inicial termina
        # en la pausa de edición de silencios (spec edicion-avanzada-shorts).
        resultado = asyncio.run(_run())
        assert resultado.pendiente_edicion_silencios is True
        assert (
            manager.obtener("job-bg").progreso.estado
            == JobStatus.ESPERANDO_EDICION_SILENCIOS
        )



# ===========================================================================
# Tarea 13 — Endpoints de subida de clips (`POST /clips`) y música (`POST /musica`)
#
# Tests de:
#   * Propiedad 1 (13.4): Almacenamiento de clips preserva orden, cardinalidad e
#     identidad. Feature: vertical-shorts-editor, Property 1.
#     Validates: Requirements 1.2, 1.3
#   * Propiedad 2 (13.5): Almacenamiento de clips es atómico.
#     Feature: vertical-shorts-editor, Property 2.
#     Validates: Requirements 1.6
#   * Tests unitarios de subida (13.6): multipart correcta (1.1); WAV inválido /
#     > 100 MB (8.2).
#
# El backend expone `POST /clips` y `POST /musica` a través de FastAPI. Los tests
# usan `fastapi.testclient.TestClient`. La verificación de dependencias del
# `lifespan` se sustituye por un doble que siempre pasa (el sandbox no tiene
# ffmpeg/auto-editor/faster-whisper), y los almacenes se inyectan mediante
# `app.dependency_overrides` apuntando a directorios temporales aislados.
# ===========================================================================

from hypothesis import HealthCheck

from fastapi.testclient import TestClient

import main
from app.api import clips as clips_api
from app.api import music as music_api
from app.deps import checker as _deps_checker
from app.storage.clip_store import ClipStore
from app.storage.music_store import MusicStore

# PBT con supresión de la comprobación de lentitud (cada ejemplo construye varios
# archivos y realiza una petición HTTP en proceso).
PBT_API = settings(
    max_examples=150,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow, HealthCheck.function_scoped_fixture],
)


def _verificacion_ok(*_args, **_kwargs) -> _deps_checker.ResultadoVerificacion:
    """Doble del Verificador de Dependencias: reporta todo disponible (Req 12.5)."""
    return _deps_checker.ResultadoVerificacion(
        resultados=[
            _deps_checker.ResultadoDependencia(nombre=n, disponible=True)
            for n in _deps_checker.DEPENDENCIAS
        ]
    )


@contextmanager
def _cliente_api(
    tmp_base: Path,
    clip_store: Optional[ClipStore] = None,
    music_store: Optional[MusicStore] = None,
) -> Iterator[TestClient]:
    """Crea un ``TestClient`` con los almacenes inyectados en directorios aislados.

    La verificación de dependencias del arranque se sustituye por un doble que
    siempre pasa, de modo que el ``lifespan`` no bloquee el arranque en el
    sandbox (mock de la verificación).
    """
    cs = clip_store if clip_store is not None else ClipStore(base_dir=tmp_base / "clips")
    ms = music_store if music_store is not None else MusicStore(base_dir=tmp_base / "musica")

    main.verificar_dependencias = _verificacion_ok  # type: ignore[assignment]
    main.app.dependency_overrides[clips_api.obtener_clip_store] = lambda: cs
    main.app.dependency_overrides[music_api.obtener_music_store] = lambda: ms
    try:
        # Sin gestor de contexto no se ejecuta el lifespan; aun así el doble
        # anterior deja el arranque en verde si alguna versión lo ejecutara.
        yield TestClient(main.app)
    finally:
        main.app.dependency_overrides.pop(clips_api.obtener_clip_store, None)
        main.app.dependency_overrides.pop(music_api.obtener_music_store, None)


# ---------------------------------------------------------------------------
# Generadores de clips de video válidos
# ---------------------------------------------------------------------------
_EXTS_VIDEO = list(config.SUPPORTED_VIDEO_EXTENSIONS)

_NOMBRE_CLIP = st.tuples(
    st.text(
        alphabet=st.characters(whitelist_categories=("L", "N"), whitelist_characters="_-"),
        min_size=1,
        max_size=12,
    ),
    st.sampled_from(_EXTS_VIDEO),
).map(lambda t: f"{t[0]}{t[1]}")

# Entrada de clip: (nombre_con_extension_soportada, contenido_pequeño_no_vacío).
_ENTRADA_CLIP = st.tuples(_NOMBRE_CLIP, st.binary(min_size=1, max_size=48))


def _multipart_clips(entradas):
    """Construye la lista ``files`` multipart para ``POST /clips``."""
    return [
        ("files", (nombre, contenido, "video/mp4")) for nombre, contenido in entradas
    ]


# ---------------------------------------------------------------------------
# Propiedad 1: Almacenamiento de clips preserva orden, cardinalidad e identidad
# Feature: vertical-shorts-editor, Property 1
# Validates: Requirements 1.2, 1.3
# ---------------------------------------------------------------------------
@PBT_API
@given(entradas=st.lists(_ENTRADA_CLIP, min_size=1, max_size=50))
def test_propiedad_1_orden_cardinalidad_identidad(entradas) -> None:
    """`POST /clips` devuelve exactamente un id único por clip y posiciones
    ``1..n`` que reproducen el orden de recepción (Req 1.2, 1.3)."""
    base = Path(tempfile.mkdtemp(prefix="vse_clips_p1_"))
    try:
        with _cliente_api(base) as client:
            resp = client.post("/clips", files=_multipart_clips(entradas))
            assert resp.status_code == 200, resp.text
            clips = resp.json()["clips"]

            n = len(entradas)
            # Cardinalidad: exactamente un clip devuelto por cada recibido.
            assert len(clips) == n
            # Orden: posiciones 1..n en el orden de recepción (Req 1.3).
            assert [c["posicion"] for c in clips] == list(range(1, n + 1))
            # Identidad: todos los identificadores distintos entre sí (Req 1.2).
            assert len({c["id"] for c in clips}) == n
            # El orden de los nombres se preserva elemento a elemento (Req 1.3).
            assert [c["nombre_original"] for c in clips] == [nombre for nombre, _ in entradas]
    finally:
        shutil.rmtree(base, ignore_errors=True)


# ---------------------------------------------------------------------------
# Propiedad 2: Almacenamiento de clips es atómico
# Feature: vertical-shorts-editor, Property 2
# Validates: Requirements 1.6
# ---------------------------------------------------------------------------
@PBT_API
@given(entradas=st.lists(_ENTRADA_CLIP, min_size=1, max_size=20), data=st.data())
def test_propiedad_2_almacenamiento_atomico(entradas, data) -> None:
    """Si el almacenamiento falla en cualquier posición, el número de clips que
    quedan almacenados es cero (sin almacenamiento parcial, Req 1.6)."""
    n = len(entradas)
    fallo_en = data.draw(st.integers(min_value=1, max_value=n))

    base = Path(tempfile.mkdtemp(prefix="vse_clips_p2_"))
    clips_dir = base / "clips"
    contador = {"n": 0}

    def escritor_con_fallo(ruta: Path, contenido: bytes) -> None:
        contador["n"] += 1
        if contador["n"] == fallo_en:
            raise OSError("fallo de disco simulado")
        ruta.parent.mkdir(parents=True, exist_ok=True)
        with open(ruta, "wb") as fh:
            fh.write(contenido)

    store = ClipStore(base_dir=clips_dir, escritor=escritor_con_fallo)
    try:
        with _cliente_api(base, clip_store=store) as client:
            resp = client.post("/clips", files=_multipart_clips(entradas))
            # La operación se rechaza con error de almacenamiento.
            assert resp.status_code == 422, resp.text
            assert resp.json()["error"]["code"] == "CLIP_STORAGE_FAILED"
            # Atomicidad (Propiedad 2): ningún clip queda almacenado en disco.
            almacenados = list(clips_dir.glob("*")) if clips_dir.exists() else []
            assert almacenados == [], f"quedó almacenamiento parcial: {almacenados}"
    finally:
        shutil.rmtree(base, ignore_errors=True)


# ---------------------------------------------------------------------------
# Helpers de WAV para los tests de música
# ---------------------------------------------------------------------------
def _wav_valido(muestras: bytes = b"\x00\x00\x01\x00") -> bytes:
    """Construye un WAV mono PCM 16 kHz mínimo pero bien formado (RIFF/WAVE)."""
    data = muestras
    fmt = (
        b"fmt "
        + (16).to_bytes(4, "little")
        + (1).to_bytes(2, "little")   # PCM
        + (1).to_bytes(2, "little")   # mono
        + (16000).to_bytes(4, "little")
        + (32000).to_bytes(4, "little")
        + (2).to_bytes(2, "little")
        + (16).to_bytes(2, "little")
    )
    data_chunk = b"data" + len(data).to_bytes(4, "little") + data
    cuerpo = b"WAVE" + fmt + data_chunk
    return b"RIFF" + len(cuerpo).to_bytes(4, "little") + cuerpo


def _mp3_falso(muestras: bytes = b"\x00" * 64) -> bytes:
    """Construye bytes con una cabecera de frame MP3 (``0xFF 0xFB``).

    Reproduce el caso real observado en producción: un archivo con contenido MP3
    (cabecera ``b"\\xff\\xfb..."``) que ffmpeg decodifica sin problemas pero que
    la antigua validación por cabecera RIFF/WAVE rechazaba como "WAV inválido".
    """
    return b"\xff\xfb\xb0\x44" + muestras


# ---------------------------------------------------------------------------
# Tests unitarios de subida (13.6)
# ---------------------------------------------------------------------------
def test_subida_multipart_correcta() -> None:
    """Subida multipart de varios clips válidos: 200 con ids únicos y orden (Req 1.1)."""
    base = Path(tempfile.mkdtemp(prefix="vse_clips_ok_"))
    try:
        with _cliente_api(base) as client:
            files = [
                ("files", ("toma1.mp4", b"aaaa", "video/mp4")),
                ("files", ("toma2.mov", b"bbbbbb", "video/quicktime")),
                ("files", ("toma3.webm", b"cc", "video/webm")),
            ]
            resp = client.post("/clips", files=files)
            assert resp.status_code == 200, resp.text
            clips = resp.json()["clips"]
            assert [c["nombre_original"] for c in clips] == ["toma1.mp4", "toma2.mov", "toma3.webm"]
            assert [c["posicion"] for c in clips] == [1, 2, 3]
            assert [c["tamano_bytes"] for c in clips] == [4, 6, 2]
            assert len({c["id"] for c in clips}) == 3
            # Los archivos quedaron persistidos en el almacén.
            assert len(list((base / "clips").glob("*"))) == 3
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_clips_rechaza_formato_no_soportado() -> None:
    """Un archivo con extensión no soportada se rechaza sin almacenar (Req 1.4)."""
    base = Path(tempfile.mkdtemp(prefix="vse_clips_fmt_"))
    try:
        with _cliente_api(base) as client:
            files = [
                ("files", ("bueno.mp4", b"aaaa", "video/mp4")),
                ("files", ("malo.txt", b"zzzz", "text/plain")),
            ]
            resp = client.post("/clips", files=files)
            assert resp.status_code == 415
            assert resp.json()["error"]["code"] == "UNSUPPORTED_FORMAT"
            # No se almacenó nada (rechazo temprano).
            assert not (base / "clips").exists() or list((base / "clips").glob("*")) == []
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_clips_rechaza_demasiados_archivos(monkeypatch) -> None:
    """Más de MAX_CLIPS_PER_UPLOAD archivos se rechaza (Req 1.5)."""
    base = Path(tempfile.mkdtemp(prefix="vse_clips_max_"))
    try:
        # Reducir el límite para no construir 51 archivos.
        monkeypatch.setattr(config, "MAX_CLIPS_PER_UPLOAD", 3)
        with _cliente_api(base) as client:
            files = [("files", (f"c{i}.mp4", b"aa", "video/mp4")) for i in range(4)]
            resp = client.post("/clips", files=files)
            assert resp.status_code == 400
            assert resp.json()["error"]["code"] == "INVALID_REQUEST"
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_musica_wav_valido() -> None:
    """Un WAV válido se acepta y devuelve un ``musica_id`` (Req 8.1)."""
    base = Path(tempfile.mkdtemp(prefix="vse_mus_ok_"))
    try:
        with _cliente_api(base) as client:
            resp = client.post(
                "/musica",
                files=[("file", ("beat.wav", _wav_valido(), "audio/wav"))],
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["musica_id"].startswith("mus_")
            assert body["nombre_original"] == "beat.wav"
            assert len(list((base / "musica").glob("*"))) == 1
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_musica_acepta_mp3() -> None:
    """Un MP3 (cabecera ``\\xff\\xfb``) con extensión soportada se acepta (Req 8.1).

    ffmpeg decodifica MP3 al mezclar, así que la subida acepta el archivo por su
    extensión aunque su contenido no sea WAV. Reproduce el caso real que antes se
    rechazaba erróneamente como "WAV inválido".
    """
    base = Path(tempfile.mkdtemp(prefix="vse_mus_mp3_"))
    try:
        with _cliente_api(base) as client:
            resp = client.post(
                "/musica",
                files=[("file", ("cancion.mp3", _mp3_falso(), "audio/mpeg"))],
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["musica_id"].startswith("mus_")
            assert body["nombre_original"] == "cancion.mp3"
            assert len(list((base / "musica").glob("*"))) == 1
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_musica_acepta_mp3_con_extension_wav() -> None:
    """Contenido MP3 con extensión ``.wav`` se acepta (extensión soportada) (Req 8.1).

    Caso real observado en producción: ``speech.wav`` cuyo contenido era MP3
    (``b"\\xff\\xfb..."``). Ahora se acepta y ffmpeg valida el contenido al mezclar.
    """
    base = Path(tempfile.mkdtemp(prefix="vse_mus_mp3wav_"))
    try:
        with _cliente_api(base) as client:
            resp = client.post(
                "/musica",
                files=[("file", ("speech.wav", _mp3_falso(), "audio/wav"))],
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()["musica_id"].startswith("mus_")
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_musica_rechaza_extension_no_soportada() -> None:
    """Un archivo con extensión no soportada se rechaza con 415 (Req 8.2)."""
    base = Path(tempfile.mkdtemp(prefix="vse_mus_bad_"))
    try:
        with _cliente_api(base) as client:
            # Extensión .txt: no es un formato de audio soportado.
            resp = client.post(
                "/musica",
                files=[("file", ("notas.txt", b"esto no es audio", "text/plain"))],
            )
            assert resp.status_code == 415
            assert resp.json()["error"]["code"] == "UNSUPPORTED_AUDIO"
            # Nada se almacenó.
            assert not (base / "musica").exists() or list((base / "musica").glob("*")) == []
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_musica_rechaza_extension_video() -> None:
    """Un archivo con extensión de video (.mp4) se rechaza (Req 8.2)."""
    base = Path(tempfile.mkdtemp(prefix="vse_mus_mp4_"))
    try:
        with _cliente_api(base) as client:
            resp = client.post(
                "/musica",
                files=[("file", ("clip.mp4", b"\x00\x00\x00\x18ftyp", "video/mp4"))],
            )
            assert resp.status_code == 415
            assert resp.json()["error"]["code"] == "UNSUPPORTED_AUDIO"
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_musica_rechaza_demasiado_grande(monkeypatch) -> None:
    """Un WAV que supera el tamaño máximo se rechaza (Req 8.2)."""
    base = Path(tempfile.mkdtemp(prefix="vse_mus_big_"))
    try:
        # Reducir el límite para no construir 100 MB en memoria.
        monkeypatch.setattr(config, "MAX_MUSIC_SIZE_BYTES", 16)
        with _cliente_api(base) as client:
            wav = _wav_valido(b"\x00" * 64)  # claramente > 16 bytes
            resp = client.post(
                "/musica",
                files=[("file", ("grande.wav", wav, "audio/wav"))],
            )
            assert resp.status_code == 413
            assert resp.json()["error"]["code"] == "MUSIC_TOO_LARGE"
            assert not (base / "musica").exists() or list((base / "musica").glob("*")) == []
    finally:
        shutil.rmtree(base, ignore_errors=True)



# ===========================================================================
# Tarea 14 — Endpoints de procesamiento (`POST /procesar`), progreso
# (`GET /progreso/{id}`) y descarga (`GET /descargar/{id}`).
#
# Tests de:
#   * Propiedad 21 (14.5): Rechazo de peticiones de procesamiento inválidas sin
#     crear Job. Feature: vertical-shorts-editor, Property 21.
#     Validates: Requirements 10.2
#   * Propiedad 24 (14.6): La descarga requiere Job completado.
#     Feature: vertical-shorts-editor, Property 24.
#     Validates: Requirements 11.3
#   * Tests unitarios (14.7): creación de Job y latencia <= 2 s (10.1); id
#     inexistente en progreso (10.4) y descarga (11.4).
#
# La verificación de dependencias del `lifespan` se sustituye por el doble que
# siempre pasa (``_verificacion_ok``, ya definido para la tarea 13). El
# ``JobManager`` y el ``JobRunner`` se inyectan vía ``app.dependency_overrides``:
# el runner usa los DOBLES (fakes) de los cinco pasos del pipeline para no
# invocar binarios reales.
# ===========================================================================

import time as _time

from app.api import download as download_api
from app.api import process as process_api
from app.api import progress as progress_api


@contextmanager
def _cliente_procesar(
    manager: Optional[JobManager] = None,
    runner: Optional[JobRunner] = None,
) -> Iterator[Tuple[TestClient, JobManager]]:
    """``TestClient`` con Gestor de Jobs y ejecutor inyectados y aislados.

    Sustituye la verificación de dependencias del arranque y cablea las tres
    dependencias compartidas (``obtener_gestor_jobs`` y ``obtener_job_runner``)
    para que ``/procesar``, ``/progreso`` y ``/descargar`` compartan el mismo
    :class:`JobManager`.
    """
    gestor = manager if manager is not None else JobManager()
    ejecutor = runner if runner is not None else JobRunner(
        gestor, **_construir_fakes(recorder=[], fallo_en=None)
    )

    main.verificar_dependencias = _verificacion_ok  # type: ignore[assignment]
    main.app.dependency_overrides[process_api.obtener_gestor_jobs] = lambda: gestor
    main.app.dependency_overrides[process_api.obtener_job_runner] = lambda: ejecutor
    try:
        yield TestClient(main.app), gestor
    finally:
        main.app.dependency_overrides.pop(process_api.obtener_gestor_jobs, None)
        main.app.dependency_overrides.pop(process_api.obtener_job_runner, None)


def _ajustes_validos_dict() -> dict:
    """Devuelve un objeto ``ajustes`` JSON-serializable, todo dentro de rango."""
    return Ajustes(musica=AjustesMusica()).model_dump()


# ---------------------------------------------------------------------------
# Propiedad 21: Rechazo de peticiones de procesamiento inválidas sin crear Job
# Feature: vertical-shorts-editor, Property 21
# Validates: Requirements 10.2
# ---------------------------------------------------------------------------
# Genera peticiones inválidas en cada una de las modalidades del Req 10.2:
#   (a) sin 'orden_clips'; (b) 'orden_clips' vacío; (c) > 500 clips; (d) sin
#   'ajustes'; (e) 'ajustes' con un campo fuera de rango.
_ID_CLIP = st.text(
    alphabet=st.characters(whitelist_categories=("L", "N"), whitelist_characters="_-"),
    min_size=1,
    max_size=6,
)


@st.composite
def _peticion_invalida(draw) -> dict:
    modalidad = draw(
        st.sampled_from(["sin_orden", "orden_vacio", "demasiados", "sin_ajustes", "ajustes_invalidos"])
    )
    ajustes_ok = _ajustes_validos_dict()

    if modalidad == "sin_orden":
        # 'orden_clips' ausente (pero ajustes presentes).
        return {"ajustes": ajustes_ok}
    if modalidad == "orden_vacio":
        return {"orden_clips": [], "ajustes": ajustes_ok}
    if modalidad == "demasiados":
        # Estrictamente más de MAX_CLIPS_PER_JOB (501..520).
        n = draw(st.integers(min_value=config.MAX_CLIPS_PER_JOB + 1, max_value=config.MAX_CLIPS_PER_JOB + 20))
        return {"orden_clips": [f"c{i}" for i in range(n)], "ajustes": ajustes_ok}
    if modalidad == "sin_ajustes":
        orden = draw(st.lists(_ID_CLIP, min_size=1, max_size=5))
        return {"orden_clips": orden}
    # ajustes_invalidos: un campo numérico fuera de rango (fps = 0 < 1).
    orden = draw(st.lists(_ID_CLIP, min_size=1, max_size=5))
    ajustes_malos = _ajustes_validos_dict()
    ajustes_malos["generales"]["fps"] = draw(st.integers(min_value=-10, max_value=0))
    return {"orden_clips": orden, "ajustes": ajustes_malos}


@PBT_API
@given(peticion=_peticion_invalida())
def test_propiedad_21_rechazo_sin_crear_job(peticion: dict) -> None:
    """Toda petición inválida a `POST /procesar` se rechaza con error de motivo y
    **no crea ningún Job** (Req 10.2)."""
    manager = JobManager()
    with _cliente_procesar(manager=manager) as (client, gestor):
        resp = client.post("/procesar", json=peticion)
        # Se rechaza con 400 INVALID_REQUEST indicando el motivo.
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "INVALID_REQUEST"
        # No se creó ningún Job (Propiedad 21).
        assert gestor.listar_ids() == []


# ---------------------------------------------------------------------------
# Propiedad 24: La descarga requiere Job completado
# Feature: vertical-shorts-editor, Property 24
# Validates: Requirements 11.3
# ---------------------------------------------------------------------------
@PBT_API
@given(
    estado=st.sampled_from(
        [JobStatus.EN_COLA, JobStatus.EN_EJECUCION, JobStatus.FALLIDO]
    )
)
def test_propiedad_24_descarga_requiere_completado(estado: JobStatus) -> None:
    """Para cualquier Job en un estado distinto de ``completado``,
    `GET /descargar/{id}` rechaza sin devolver archivo e indica que el
    Video_Final no está disponible (Req 11.3)."""
    manager = JobManager()
    manager.crear_job("job-dl", ["a"], _ajustes_con_musica(), workdir="wd")
    # Situar el Job en un estado no completado.
    if estado == JobStatus.EN_EJECUCION:
        manager.marcar_en_ejecucion("job-dl")
    elif estado == JobStatus.FALLIDO:
        manager.marcar_fallido("job-dl", PipelineStep.UNIR, "fallo simulado")
    # (EN_COLA es el estado inicial tras crear_job.)

    with _cliente_procesar(manager=manager) as (client, _gestor):
        resp = client.get("/descargar/job-dl")
        assert resp.status_code == 409, resp.text
        assert resp.json()["error"]["code"] == "RESULT_NOT_READY"
        # No se devuelve ningún archivo (respuesta JSON de error, no binario).
        assert resp.headers["content-type"].startswith("application/json")


# ---------------------------------------------------------------------------
# Tests unitarios (14.7): creación de Job + latencia (10.1); id inexistente en
# progreso (10.4) y descarga (11.4).
# ---------------------------------------------------------------------------
def test_procesar_crea_job_y_responde_rapido() -> None:
    """`POST /procesar` válido crea un Job y responde 202 con job_id en <= 2 s (Req 10.1)."""
    with isolated_config_dirs():
        manager = JobManager()
        with _cliente_procesar(manager=manager) as (client, gestor):
            inicio = _time.monotonic()
            resp = client.post(
                "/procesar",
                json={
                    "orden_clips": ["a", "b", "c"],
                    "musica_id": None,
                    "ajustes": _ajustes_validos_dict(),
                },
            )
            transcurrido = _time.monotonic() - inicio

            assert resp.status_code == 202, resp.text
            body = resp.json()
            assert body["job_id"].startswith("job_")
            assert body["estado"] == "en_cola"
            # Latencia de respuesta <= 2 s (Req 10.1).
            assert transcurrido <= 2.0
            # El Job quedó registrado en el Gestor (creación de Job).
            assert body["job_id"] in gestor.listar_ids()


def test_progreso_json_de_job_existente() -> None:
    """`GET /progreso/{id}` (polling) devuelve el objeto de progreso (Req 10.3)."""
    manager = JobManager()
    manager.crear_job("job-prog", ["a"], _ajustes_con_musica(), workdir="wd")
    manager.actualizar_progreso(
        "job-prog", estado=JobStatus.EN_EJECUCION, indice_paso=3,
        paso_actual=PipelineStep.TRANSCRIBIR, porcentaje=55, mensaje="Transcribiendo",
    )
    with _cliente_procesar(manager=manager) as (client, _gestor):
        resp = client.get("/progreso/job-prog")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["job_id"] == "job-prog"
        assert body["estado"] == "en_ejecucion"
        assert body["paso_actual"] == "TRANSCRIBIR"
        assert body["indice_paso"] == 3
        assert body["porcentaje"] == 55
        assert body["total_pasos"] == 5
        assert body["error"] is None


def test_progreso_sse_de_job_terminal() -> None:
    """La variante SSE (`?stream=true`) emite el progreso como evento y cierra el
    stream cuando el Job es terminal (Req 10.6)."""
    manager = JobManager()
    manager.crear_job("job-sse", ["a"], _ajustes_con_musica(), workdir="wd")
    manager.marcar_completado("job-sse", ruta_video_final="/out/job-sse/final.mp4")

    with _cliente_procesar(manager=manager) as (client, _gestor):
        resp = client.get("/progreso/job-sse?stream=true")
        assert resp.status_code == 200, resp.text
        assert resp.headers["content-type"].startswith("text/event-stream")
        cuerpo = resp.text
        assert "event: progreso" in cuerpo
        assert '"estado": "completado"' in cuerpo
        assert '"job_id": "job-sse"' in cuerpo


def test_progreso_id_inexistente_devuelve_404() -> None:
    """`GET /progreso/{id}` con id inexistente devuelve 404 JOB_NOT_FOUND (Req 10.4)."""
    with _cliente_procesar(manager=JobManager()) as (client, gestor):
        resp = client.get("/progreso/no-existe")
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "JOB_NOT_FOUND"
        # Sin efectos: no se creó ningún Job por la consulta (Req 10.4).
        assert gestor.listar_ids() == []


def test_descargar_id_inexistente_devuelve_404() -> None:
    """`GET /descargar/{id}` con id inexistente devuelve 404 JOB_NOT_FOUND (Req 11.4)."""
    with _cliente_procesar(manager=JobManager()) as (client, _gestor):
        resp = client.get("/descargar/no-existe")
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "JOB_NOT_FOUND"


def test_descargar_job_completado_envia_mp4() -> None:
    """Un Job completado con Video_Final en disco se descarga como MP4 adjunto (Req 11.2)."""
    base = Path(tempfile.mkdtemp(prefix="vse_dl_ok_"))
    try:
        ruta_final = base / "final.mp4"
        ruta_final.write_bytes(b"\x00\x00\x00\x18ftypmp42fake-mp4-bytes")

        manager = JobManager()
        manager.crear_job("job-ok-dl", ["a"], _ajustes_con_musica(), workdir="wd")
        manager.marcar_completado("job-ok-dl", ruta_video_final=str(ruta_final))

        with _cliente_procesar(manager=manager) as (client, _gestor):
            resp = client.get("/descargar/job-ok-dl")
            assert resp.status_code == 200, resp.text
            assert resp.headers["content-type"] == "video/mp4"
            assert "attachment" in resp.headers.get("content-disposition", "")
            assert resp.content == ruta_final.read_bytes()
    finally:
        shutil.rmtree(base, ignore_errors=True)



# ===========================================================================
# BUGFIX — Resolución de IDs de clip a rutas en el pipeline (ffprobe)
#
# El ``Orden_de_Clips`` almacenado en un Job contiene IDENTIFICADORES de clip,
# pero el pipeline (paso UNIR → ``ffprobe``) necesita RUTAS de archivo reales.
# Antes, el runner pasaba los ids tal cual y ``ffprobe`` fallaba con
# "No such file or directory". El runner ahora resuelve cada id a su ruta con el
# ``resolver_clip`` inyectable (identidad por defecto para no romper otros tests).
# ===========================================================================


def test_resolver_clip_por_id_encuentra_por_glob_y_none_si_no_existe() -> None:
    """`_resolver_clip_por_id` devuelve la ruta del archivo del clip por glob, o
    ``None`` si no hay coincidencia o el id es vacío."""
    from app.api.process import _resolver_clip_por_id

    with isolated_config_dirs():
        base = ClipStore().base_dir
        base.mkdir(parents=True, exist_ok=True)
        (base / "clip_existente.mp4").write_bytes(b"fake-mp4")

        # Encuentra la ruta real por glob {id}.*
        assert _resolver_clip_por_id("clip_existente") == str(base / "clip_existente.mp4")
        # Sin coincidencia -> None.
        assert _resolver_clip_por_id("clip_inexistente") is None
        # Id vacío -> None (sin efectos).
        assert _resolver_clip_por_id("") is None


def test_runner_resuelve_ids_de_clip_a_rutas() -> None:
    """El runner traduce los ids del Orden_de_Clips a RUTAS de archivo reales
    antes de invocar el pipeline (BUG: ffprobe recibía ids en vez de rutas)."""
    from app.api.process import _resolver_clip_por_id

    with isolated_config_dirs():
        # Crear archivos reales de clip en el almacén ({id}.mp4).
        base = ClipStore().base_dir
        base.mkdir(parents=True, exist_ok=True)
        ids = ["clip_aaa", "clip_bbb"]
        for cid in ids:
            (base / f"{cid}.mp4").write_bytes(b"fake-mp4")

        manager = JobManager()
        manager.crear_job("job-resolver", ids, _ajustes_con_musica(), workdir="wd")

        capturado: Dict[str, List[str]] = {}
        fakes = _construir_fakes(recorder=[], fallo_en=None)

        def fn_unir_captura(job, orden, ancho, alto, fps, **kw):  # noqa: ANN001
            capturado["orden"] = list(orden)
            return job.resolve("unido.mp4")

        fakes["fn_unir"] = fn_unir_captura

        runner = JobRunner(
            manager,
            resolver_clip=(lambda cid: _resolver_clip_por_id(cid) or cid),
            **fakes,
        )

        resultado = runner.ejecutar_job("job-resolver")

        # La resolución de ids ocurre en el paso UNIR (fase inicial); el runner se
        # pausa después en la edición de silencios (spec edicion-avanzada-shorts).
        assert resultado.pendiente_edicion_silencios is True
        # El pipeline recibió RUTAS resueltas, no los ids.
        rutas_esperadas = [str(base / f"{cid}.mp4") for cid in ids]
        assert capturado["orden"] == rutas_esperadas
        for ruta, cid in zip(capturado["orden"], ids):
            assert ruta != cid
            assert Path(ruta).exists()


def test_runner_resolver_clip_por_defecto_es_identidad() -> None:
    """Sin ``resolver_clip`` inyectado, el runner conserva los ids tal cual (no
    rompe los tests existentes que usan ids ficticios sin archivos en disco)."""
    with isolated_config_dirs():
        manager = JobManager()
        manager.crear_job("job-id", ["id-1", "id-2"], _ajustes_con_musica(), workdir="wd")

        capturado: Dict[str, List[str]] = {}
        fakes = _construir_fakes(recorder=[], fallo_en=None)

        def fn_unir_captura(job, orden, ancho, alto, fps, **kw):  # noqa: ANN001
            capturado["orden"] = list(orden)
            return job.resolve("unido.mp4")

        fakes["fn_unir"] = fn_unir_captura

        runner = JobRunner(manager, **fakes)
        resultado = runner.ejecutar_job("job-id")

        # La fase inicial termina en la pausa de edición de silencios
        # (edicion-avanzada-shorts); los ids se conservan tal cual con el
        # resolutor por defecto (identidad).
        assert resultado.pendiente_edicion_silencios is True
        assert capturado["orden"] == ["id-1", "id-2"]


# ===========================================================================
# Validación de audio: la variante RF64 (archivos grandes) sigue aceptándose
#
# Un WAV RF64 (contenedor WAVE con firma RF64 en vez de RIFF) usa la extensión
# ``.wav`` y, con la política basada en extensión, se acepta como cualquier otro
# formato de audio soportado.
# ===========================================================================


def _rf64_valido(muestras: bytes = b"\x00\x00\x01\x00") -> bytes:
    """Construye un WAV con cabecera RF64 (variante para archivos grandes)."""
    wav = _wav_valido(muestras)
    # Sustituir la firma de contenedor RIFF por RF64 conservando el resto.
    return b"RF64" + wav[4:]


def test_musica_acepta_rf64() -> None:
    """Un WAV con cabecera RF64...WAVE se acepta y devuelve ``musica_id`` (Req 8.1)."""
    base = Path(tempfile.mkdtemp(prefix="vse_mus_rf64_"))
    try:
        with _cliente_api(base) as client:
            resp = client.post(
                "/musica",
                files=[("file", ("grande.wav", _rf64_valido(), "audio/wav"))],
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["musica_id"].startswith("mus_")
            assert body["nombre_original"] == "grande.wav"
            assert len(list((base / "musica").glob("*"))) == 1
    finally:
        shutil.rmtree(base, ignore_errors=True)
