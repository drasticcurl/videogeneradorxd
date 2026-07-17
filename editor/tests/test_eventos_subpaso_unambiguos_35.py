"""Task 3.5 — Unambiguous, correlated events for each substep (Property 1) for
the ``unir-step-hang`` diagnostic-first bugfix.

**Validates: Requirements 2.2, 2.3**

These tests pin the ADDITIVE instrumentation of Task 3.5: every substep around
the opaque 25 % boundary emits a DISTINGUISHABLE, CORRELATED event so the last
confirmed event localizes a stall into exactly one of the four categories
A/B/C/D of the design's "Diagnostic Decision Matrix":

* the pipeline emits differentiated :class:`EventoProgreso` events for
  materialization, UNIR start/done, silence-detection start/**done**, and the
  ``ESPERANDO_EDICION_SILENCIOS`` pause — each carrying the full correlation
  tuple and a structured ``subpaso``/``evento_tipo`` (never the percentage as
  the state, Req 2.2);
* the **silence-detection-done** event (``deteccion_fin``) is emitted BEFORE the
  pause with the segment count and duration, so category B (detection blocked:
  ``deteccion_inicio`` but no ``deteccion_fin``) is distinguishable from category
  C (detection done, pause not propagated) (Req 2.3);
* ``unir_clips`` logs distinguishable correlated substep events for the per-clip
  ``ffprobe``, per-clip normalization and the concat, so a UNIR block is
  localizable into category A;
* ``detectar_silencios`` logs a correlated ``deteccion_fin`` with the segment
  count and duration;
* the runner logs the correlated pause → ``awaiting_silences`` transition.

Video content is NEVER logged (only ids/counts/durations/states). All drives
use injected doubles (no real binaries) under a hard wall-clock cap so the suite
can never hang.
"""

from __future__ import annotations

import concurrent.futures
import logging
import tempfile
from pathlib import Path
from typing import Any, List, Optional, Sequence, Tuple

from app import config
from app.engine.ffprobe import ClipInfo
from app.engine.normalize import unir_clips
from app.engine.pipeline import EventoProgreso, ejecutar_pipeline
from app.engine.proc import ResultadoComando
from app.engine.silence import ResultadoDeteccionSilencios, detectar_silencios
from app.jobs.manager import JobManager
from app.jobs.runner import JobRunner
from app.models.settings import Ajustes
from app.storage.workdir import JobWorkdir

_WALL_CLOCK_CAP_S: float = 5.0

# The correlation-tuple keys every differentiated boundary event must carry.
_CLAVES_CORRELACION = {"version", "revision", "edit_job_id", "editor_job_id"}

# The full, ordered set of differentiated substep event kinds Task 3.5 emits.
_TIPOS_SUBPASO = {
    "materializacion",
    "unir_inicio",
    "unir_fin",
    "deteccion_inicio",
    "deteccion_fin",
    "pausa_silencios",
}

_CORRELACION_EJEMPLO = {
    "version": "img-tag v0.9123 banana xD",
    "revision": "editor-00042-abc",
    "edit_job_id": "edit-job-77",
    "editor_job_id": "job_deadbeef",
}


# ---------------------------------------------------------------------------
# Injected doubles (no real binaries)
# ---------------------------------------------------------------------------
def _fake_unir(job, orden_clips, ancho, alto, fps, *, runner, inspector, **_kw) -> Path:
    return job.resolve("unido.mp4")


def _detectar_con(silencios: List[Tuple[float, float]], duracion: float):
    def _fake(unido, *, umbral_db, margen_ms, modo, runner, **_kw):
        return ResultadoDeteccionSilencios(silencios=list(silencios), duracion=duracion)

    return _fake


def _drive_pipeline(
    orden_clips: Sequence[str],
    silencios: List[Tuple[float, float]],
    duracion: float,
    correlacion: Optional[dict],
) -> List[EventoProgreso]:
    """Run ``ejecutar_pipeline`` (silences enabled) under a wall-clock cap."""
    eventos: List[EventoProgreso] = []

    def _run() -> None:
        tmp = Path(tempfile.mkdtemp(prefix="subpaso-35-"))
        prev_wk, prev_out = config.WORKDIR_ROOT, config.OUTPUT_ROOT
        config.WORKDIR_ROOT = tmp / "wk"
        config.OUTPUT_ROOT = tmp / "out"
        try:
            job = JobWorkdir("subpaso-35")
            ajustes = Ajustes()  # silencios.activado == True by default
            kwargs: dict = dict(
                reporter=eventos.append,
                fn_unir=_fake_unir,
                fn_detectar=_detectar_con(silencios, duracion),
            )
            if correlacion is not None:
                kwargs["correlacion"] = correlacion
            ejecutar_pipeline(job, list(orden_clips), ajustes, **kwargs)
        finally:
            config.WORKDIR_ROOT = prev_wk
            config.OUTPUT_ROOT = prev_out

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        pool.submit(_run).result(timeout=_WALL_CLOCK_CAP_S)
    return eventos


def _tipos(eventos: Sequence[EventoProgreso]) -> List[str]:
    return [e.evento_tipo for e in eventos if e.evento_tipo]


# ---------------------------------------------------------------------------
# Pipeline-level differentiated, correlated events
# ---------------------------------------------------------------------------
def test_cada_subpaso_emite_evento_distinguible_y_correlacionado() -> None:
    """Materialization, UNIR-done, detection start/done and the pause are each
    emitted as a differentiated, correlated event (subpaso + evento_tipo + full
    correlation tuple), so the last confirmed event classifies the job."""
    eventos = _drive_pipeline(
        ["/clips/a.mp4", "/clips/b.mp4"], [(1.0, 2.0)], 10.0, _CORRELACION_EJEMPLO
    )
    tipos = _tipos(eventos)

    # All six differentiated substep kinds are observable.
    assert _TIPOS_SUBPASO.issubset(set(tipos)), (
        "missing differentiated substep events; observed: %s" % sorted(set(tipos))
    )

    # The detection-DONE event precedes the pause (B-vs-C distinguishability).
    assert tipos.index("deteccion_fin") < tipos.index("pausa_silencios")
    assert tipos.index("deteccion_inicio") < tipos.index("deteccion_fin")
    assert tipos.index("unir_fin") < tipos.index("deteccion_inicio")
    assert tipos.index("materializacion") < tipos.index("unir_inicio")

    # Every differentiated substep event carries a subpaso and the full
    # correlation tuple, and its (evento_tipo, subpaso) signature is unique.
    subpaso_events = [e for e in eventos if e.evento_tipo in _TIPOS_SUBPASO]
    firmas = set()
    for ev in subpaso_events:
        assert ev.subpaso, f"event {ev.evento_tipo} lacks a subpaso"
        assert ev.correlacion is not None
        assert _CLAVES_CORRELACION.issubset(ev.correlacion.keys())
        assert ev.correlacion["edit_job_id"] == "edit-job-77"
        assert ev.correlacion["editor_job_id"] == "job_deadbeef"
        firmas.add((ev.evento_tipo, ev.subpaso))
    assert len(firmas) == len(_TIPOS_SUBPASO)


def test_deteccion_fin_lleva_conteo_de_tramos_y_duracion() -> None:
    """The silence-detection-done event carries the segment count and duration
    (in its message), so category C is confirmable with concrete evidence."""
    eventos = _drive_pipeline(
        ["/clips/a.mp4"], [(1.0, 2.0), (5.0, 6.5)], 12.5, _CORRELACION_EJEMPLO
    )
    fin = next(e for e in eventos if e.evento_tipo == "deteccion_fin")
    # Segment count (2) and duration (12.5) appear in the message.
    assert "2" in fin.mensaje
    assert "12.5" in fin.mensaje
    # The pause event still follows and is distinguishable.
    assert any(e.evento_tipo == "pausa_silencios" for e in eventos)


def test_eventos_del_borde_correlacionados_incluso_sin_tupla_explicita() -> None:
    """Even when the caller passes NO correlation, every differentiated boundary
    event still carries the full correlation tuple (keys present), so the job is
    correlatable end-to-end (Req 2.5)."""
    eventos = _drive_pipeline(["/clips/a.mp4", "/clips/b.mp4"], [(1.0, 2.0)], 10.0, None)
    subpaso_events = [e for e in eventos if e.evento_tipo in _TIPOS_SUBPASO]
    assert subpaso_events
    for ev in subpaso_events:
        assert ev.correlacion is not None
        assert _CLAVES_CORRELACION.issubset(ev.correlacion.keys())
        # editor_job_id defaults to the workdir job id when none is provided.
        assert ev.correlacion["editor_job_id"] == "subpaso-35"


def test_eventos_no_llevan_contenido_de_video() -> None:
    """No differentiated event carries video content in its correlation (only the
    four canonical id/state keys)."""
    eventos = _drive_pipeline(
        ["/clips/a.mp4", "/clips/b.mp4"], [(1.0, 2.0)], 10.0, _CORRELACION_EJEMPLO
    )
    for ev in eventos:
        if ev.correlacion is None:
            continue
        assert set(ev.correlacion.keys()) <= _CLAVES_CORRELACION
        blob = repr(ev.correlacion).lower()
        assert ".mp4" not in blob and "video" not in blob


# ---------------------------------------------------------------------------
# unir_clips — per-clip ffprobe / normalization / concat substep logs
# ---------------------------------------------------------------------------
def _runner_ok(args: Sequence[str], timeout: Optional[float] = None) -> ResultadoComando:
    return ResultadoComando(returncode=0, stdout="10.0", stderr="")


def _clip_info(ruta: str) -> ClipInfo:
    return ClipInfo(
        ruta=ruta,
        ancho=1920,
        alto=1080,
        rotacion=0,
        fps=30.0,
        duracion_s=8.0,
        tiene_video=True,
        tiene_audio=True,
    )


def test_unir_clips_emite_subpasos_correlacionados(tmp_path, monkeypatch, caplog) -> None:
    """``unir_clips`` emits distinguishable correlated substep events for the
    per-clip ffprobe, per-clip normalization and the concat (category A)."""
    monkeypatch.setattr(config, "WORKDIR_ROOT", tmp_path / "wk")
    monkeypatch.setattr(config, "OUTPUT_ROOT", tmp_path / "out")
    job = JobWorkdir("job-subpaso-unir")
    correlacion = dict(_CORRELACION_EJEMPLO)

    with caplog.at_level(logging.INFO, logger="app.engine.normalize"):
        unir_clips(
            job,
            ["/clips/a.mp4", "/clips/b.mp4"],
            ancho_objetivo=1080,
            alto_objetivo=1920,
            fps=30,
            runner=_runner_ok,
            inspector=_clip_info,
            correlacion=correlacion,
        )

    subpaso_lines = [r.getMessage() for r in caplog.records if "UNIR subpaso" in r.getMessage()]
    tipos_vistos = {
        tipo
        for tipo in (
            "materializacion",
            "ffprobe_inicio",
            "ffprobe_fin",
            "normalizar_inicio",
            "normalizar_fin",
            "concat_inicio",
            "concat_fin",
        )
        if any("evento_tipo=%s" % tipo in line for line in subpaso_lines)
    }
    # Every UNIR substep kind is observable as a distinguishable event.
    assert {
        "ffprobe_inicio",
        "ffprobe_fin",
        "normalizar_inicio",
        "normalizar_fin",
        "concat_inicio",
        "concat_fin",
    }.issubset(tipos_vistos)

    # Every substep line carries the correlation (edit/editor job ids).
    assert subpaso_lines
    for line in subpaso_lines:
        assert "edit_job_id" in line and "editor_job_id" in line
        # No video content / clip paths in the correlated substep logs.
        assert ".mp4" not in line


# ---------------------------------------------------------------------------
# detectar_silencios — correlated detection-done log with count + duration
# ---------------------------------------------------------------------------
def test_detectar_silencios_loguea_deteccion_fin_correlacionada(caplog) -> None:
    """``detectar_silencios`` logs a correlated ``deteccion_fin`` carrying the
    segment count and duration (never video content)."""
    correlacion = dict(_CORRELACION_EJEMPLO)
    with caplog.at_level(logging.INFO, logger="app.engine.silence"):
        # No silences in the (empty) silencedetect stderr; duration 10.0 from the
        # ffprobe double → tramos=0, duracion=10.000.
        detectar_silencios(
            "/tmp/unido.mp4",
            umbral_db=-30.0,
            margen_ms=0.0,
            modo="db",
            runner=_runner_ok,
            correlacion=correlacion,
        )
    fin_lines = [
        r.getMessage()
        for r in caplog.records
        if "evento_tipo=deteccion_fin" in r.getMessage()
    ]
    assert fin_lines, "no deteccion_fin log emitted"
    line = fin_lines[-1]
    assert "tramos=0" in line
    assert "duracion=10.000" in line
    assert "edit_job_id" in line and "editor_job_id" in line


# ---------------------------------------------------------------------------
# runner — correlated pause → awaiting_silences transition log
# ---------------------------------------------------------------------------
def test_runner_loguea_pausa_awaiting_silences_correlacionada(
    tmp_path, monkeypatch, caplog
) -> None:
    """The runner logs the correlated pause → ``awaiting_silences`` transition
    when the pipeline reaches ``ESPERANDO_EDICION_SILENCIOS`` (category C)."""
    monkeypatch.setattr(config, "WORKDIR_ROOT", tmp_path / "wk")
    monkeypatch.setattr(config, "OUTPUT_ROOT", tmp_path / "out")
    monkeypatch.setenv("APP_VERSION", "img-tag v0.9123 banana xD")
    monkeypatch.setenv("K_REVISION", "editor-00042-abc")

    manager = JobManager()
    manager.crear_job("job-pausa-35", ["c1", "c2"], Ajustes(), workdir="wd")
    runner = JobRunner(
        manager,
        runner=_runner_ok,
        fn_unir=_fake_unir,
        fn_detectar=_detectar_con([(1.0, 2.0)], 10.0),
    )

    with caplog.at_level(logging.INFO, logger="app.jobs.runner"):
        resultado = runner.ejecutar_job("job-pausa-35")

    assert resultado.pendiente_edicion_silencios is True
    pausa_lines = [
        r.getMessage()
        for r in caplog.records
        if "evento_tipo=pausa_silencios" in r.getMessage()
        and "estado=awaiting_silences" in r.getMessage()
    ]
    assert pausa_lines, "no correlated pause → awaiting_silences log emitted"
    line = pausa_lines[-1]
    assert "tramos=1" in line
    # Correlation carries the effective version/revision from the environment.
    assert "editor_job_id" in line
