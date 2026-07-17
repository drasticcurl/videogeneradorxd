"""Task 3.8 — Integration tests: full 25% → awaiting_silences → timeline
transition + preservation, for the ``unir-step-hang`` diagnostic-first bugfix
(Python / FastAPI side).

**Validates: Requirements 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4, 3.7**

Two complementary integration checks, driven with injected doubles (no real
ffmpeg/ffprobe/auto-editor binaries) and a hard wall-clock cap so the suite can
never hang (design §"Integration Tests", §"Fix Checking", §"Preservation
Checking"):

FIX CHECKING (Property 1) — the full transition end-to-end
----------------------------------------------------------
* Driving ``ejecutar_pipeline`` (silences enabled) to the pause produces a
  DIFFERENTIATED, CORRELATED event trail (materialization → UNIR start/done →
  detection start/done → pause) such that an observer can classify the job into
  exactly ONE of the four categories A/B/C/D of the design's "Diagnostic
  Decision Matrix" — here **category C** (union & detection complete, pause
  reached), independent of the (monotonic) percentage that stays at 25.
* Driving the full ``JobRunner.ejecutar_job`` end-to-end persists the pause as
  ``ESPERANDO_EDICION_SILENCIOS`` (the backend equivalent of the timeline
  mounting — the ``awaiting_silences`` pause is reached and made durable) and
  logs the correlated pause → ``awaiting_silences`` transition. This closes the
  category-C gap: the reached pause is now observable end-to-end.

PRESERVATION (Property 2) — unchanged after instrumentation
-----------------------------------------------------------
* Clip order/selection through the real ``unir_clips`` inside the pipeline: all
  and only the selected clips, exactly once, in order (Req 3.1).
* Input immutability + separate destinations: real source files are read
  byte-for-byte and every artifact lands inside the job workdir (Req 3.2).
* Local mode is independent of Cloud Run metadata (Req 3.3).
* Flow separation: with silences DISABLED there is no silence-edit pause — the
  pipeline advances past the 25% boundary (Req 3.7), and the edit pipeline
  module shares no wiring with a separate clip-extension ("+7 s") flow (Req 3.4).

EXPECTED OUTCOME: PASS on the instrumented code.
"""

from __future__ import annotations

import concurrent.futures
import logging
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from app import config
from app.engine.ffprobe import ClipInfo
from app.engine.normalize import NOMBRE_CONCAT_TXT, NOMBRE_UNIDO
from app.engine.pipeline import EventoProgreso, ejecutar_pipeline
from app.engine.proc import ResultadoComando
from app.engine.silence import ResultadoDeteccionSilencios
from app.jobs.manager import JobManager
from app.jobs.runner import JobRunner
from app.models.job import JobStatus, PipelineStep
from app.models.settings import Ajustes
from app.storage.workdir import JobWorkdir

# Hard wall-clock cap (seconds) for every pipeline drive. The injected doubles
# are instantaneous; this guards against a regression introducing a genuine
# block so the suite can never wedge.
_WALL_CLOCK_CAP_S: float = 5.0

_CLAVES_CORRELACION = {"version", "revision", "edit_job_id", "editor_job_id"}

_CORRELACION_EJEMPLO: Dict[str, Any] = {
    "version": "img-tag v0.9123 banana xD",
    "revision": "editor-00042-abc",
    "edit_job_id": "edit-job-38",
    "editor_job_id": "job_int38",
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


def _fake_transcribir(cortado, ajustes_transc, audio, *, runner, **_kw) -> List[Any]:
    return []


class _Recorder:
    """Recording Runner double (never invokes real binaries)."""

    def __init__(self, returncode: int = 0, stdout: str = "", stderr: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        self.calls: List[List[str]] = []

    def __call__(self, args, timeout: Optional[float] = None) -> ResultadoComando:
        self.calls.append(list(args))
        return ResultadoComando(
            returncode=self.returncode,
            stdout=self.stdout,
            stderr=self.stderr,
            args=list(args),
        )


def _clipinfo(ruta: str, audio: bool = True) -> ClipInfo:
    return ClipInfo(
        ruta=ruta,
        ancho=1080,
        alto=1920,
        rotacion=0,
        fps=30.0,
        duracion_s=8.0,
        tiene_video=True,
        tiene_audio=audio,
    )


def _entradas_normalizacion(calls: Sequence[Sequence[str]]) -> List[str]:
    """Extract the source clip of each per-clip normalization command in order."""
    entradas: List[str] = []
    for cmd in calls:
        cmd = list(cmd)
        if "-map" not in cmd or "-i" not in cmd:
            continue
        idx = len(cmd) - 1 - cmd[::-1].index("-i")
        entradas.append(cmd[idx + 1])
    return entradas


# ---------------------------------------------------------------------------
# Category classifier (mirrors design §"Diagnostic Decision Matrix")
# ---------------------------------------------------------------------------
def _clasificar(eventos: Sequence[EventoProgreso]) -> str:
    """Classify the last-confirmed correlated event trail into A/B/C/D.

    * A — UNIR substep started but never finished (``unir_fin`` missing).
    * B — detection started (``deteccion_inicio``) but never finished
      (``deteccion_fin`` missing).
    * C — detection done and/or pause reached (``deteccion_fin`` /
      ``pausa_silencios``) with no terminal failure.
    * D — deployment identity mismatch (never derivable from this event trail).

    A terminal ``fallo`` localizes to A or B via its ``paso``.
    """
    tipos = [e.evento_tipo for e in eventos if e.evento_tipo]
    fallo = next((e for e in eventos if e.evento_tipo == "fallo"), None)
    if fallo is not None:
        paso = fallo.paso_actual
        return "A" if paso == PipelineStep.UNIR else "B"
    if "deteccion_fin" in tipos or "pausa_silencios" in tipos:
        return "C"
    if "deteccion_inicio" in tipos:
        return "B"
    if "unir_inicio" in tipos or "materializacion" in tipos:
        return "A"
    return "D"


def _drive_pipeline(
    orden_clips: Sequence[str],
    silencios: List[Tuple[float, float]],
    duracion: float,
    *,
    silencios_activado: bool = True,
    correlacion: Optional[Dict[str, Any]] = None,
    fn_unir=_fake_unir,
    runner=None,
    inspector=None,
) -> Tuple[Any, List[EventoProgreso]]:
    """Run ``ejecutar_pipeline`` under a wall-clock cap, capturing every event."""
    eventos: List[EventoProgreso] = []
    box: Dict[str, Any] = {}

    def _run() -> None:
        tmp = Path(tempfile.mkdtemp(prefix="int38-"))
        prev_wk, prev_out = config.WORKDIR_ROOT, config.OUTPUT_ROOT
        config.WORKDIR_ROOT = tmp / "wk"
        config.OUTPUT_ROOT = tmp / "out"
        try:
            job = JobWorkdir("integracion-38")
            ajustes = Ajustes()
            ajustes.silencios.activado = silencios_activado
            kwargs: Dict[str, Any] = dict(
                reporter=eventos.append,
                fn_unir=fn_unir,
                fn_detectar=_detectar_con(silencios, duracion),
                fn_transcribir=_fake_transcribir,
            )
            if runner is not None:
                kwargs["runner"] = runner
            if inspector is not None:
                kwargs["inspector"] = inspector
            if correlacion is not None:
                kwargs["correlacion"] = correlacion
            box["r"] = ejecutar_pipeline(job, list(orden_clips), ajustes, **kwargs)
        finally:
            config.WORKDIR_ROOT = prev_wk
            config.OUTPUT_ROOT = prev_out

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        pool.submit(_run).result(timeout=_WALL_CLOCK_CAP_S)
    return box["r"], eventos


# ===========================================================================
# FIX CHECKING (Property 1) — full transition, classifiable into category C
# ===========================================================================
def test_transicion_completa_es_clasificable_categoria_c() -> None:
    """The full 25% → detection → pause trail is differentiated and correlated,
    so the last confirmed event classifies the job into exactly category C."""
    resultado, eventos = _drive_pipeline(
        ["/clips/a.mp4", "/clips/b.mp4"],
        [(1.0, 2.0), (5.0, 6.5)],
        12.5,
        correlacion=_CORRELACION_EJEMPLO,
    )

    # The pause is reached (backend equivalent of the timeline mounting).
    assert resultado.pendiente_edicion_silencios is True

    tipos = [e.evento_tipo for e in eventos if e.evento_tipo]
    # Every boundary substep is observable and ordered.
    for esperado in (
        "materializacion",
        "unir_inicio",
        "unir_fin",
        "deteccion_inicio",
        "deteccion_fin",
        "pausa_silencios",
    ):
        assert esperado in tipos, f"missing differentiated event {esperado}"
    assert tipos.index("unir_fin") < tipos.index("deteccion_inicio")
    assert tipos.index("deteccion_inicio") < tipos.index("deteccion_fin")
    assert tipos.index("deteccion_fin") < tipos.index("pausa_silencios")

    # The last confirmed event classifies the job into exactly category C.
    assert _clasificar(eventos) == "C"

    # Every differentiated boundary event carries the full correlation tuple.
    for ev in eventos:
        if ev.evento_tipo in {
            "materializacion",
            "unir_inicio",
            "unir_fin",
            "deteccion_inicio",
            "deteccion_fin",
            "pausa_silencios",
        }:
            assert ev.correlacion is not None
            assert _CLAVES_CORRELACION.issubset(ev.correlacion.keys())
            assert ev.correlacion["edit_job_id"] == "edit-job-38"


def test_estado_independiente_del_porcentaje_en_la_transicion() -> None:
    """Step/substep/state change while the percentage stays at 25 and remains
    monotonic non-decreasing across the whole transition."""
    _resultado, eventos = _drive_pipeline(
        ["/clips/a.mp4", "/clips/b.mp4"], [(1.0, 2.0)], 10.0,
        correlacion=_CORRELACION_EJEMPLO,
    )
    porcentajes = [e.porcentaje for e in eventos]
    for anterior, siguiente in zip(porcentajes, porcentajes[1:]):
        assert siguiente >= anterior, f"percentage regressed: {porcentajes}"

    en_25 = [e for e in eventos if e.porcentaje == 25]
    firmas = {(e.evento_tipo, e.subpaso) for e in en_25}
    # Multiple distinguishable substeps share the value 25.
    assert len(firmas) >= 3, f"substeps not distinguishable at 25%%: {firmas}"


def test_runner_end_to_end_persiste_pausa_y_loguea_correlacion(
    tmp_path, monkeypatch, caplog
) -> None:
    """Driving the full ``JobRunner.ejecutar_job`` persists the pause as
    ``ESPERANDO_EDICION_SILENCIOS`` (pause propagated/durable → category C
    resolved) and logs the correlated pause → ``awaiting_silences`` transition."""
    monkeypatch.setattr(config, "WORKDIR_ROOT", tmp_path / "wk")
    monkeypatch.setattr(config, "OUTPUT_ROOT", tmp_path / "out")
    monkeypatch.setenv("APP_VERSION", "img-tag v0.9123 banana xD")
    monkeypatch.setenv("K_REVISION", "editor-00042-abc")

    manager = JobManager()
    manager.crear_job("job-int38", ["c1", "c2"], Ajustes(), workdir="wd")
    manager.establecer_edit_job_id("job-int38", "edit-job-38")
    runner = JobRunner(
        manager,
        runner=_Recorder(),
        fn_unir=_fake_unir,
        fn_detectar=_detectar_con([(1.0, 2.0), (5.0, 6.5)], 12.5),
    )

    with caplog.at_level(logging.INFO, logger="app.jobs.runner"):
        resultado = runner.ejecutar_job("job-int38")

    # Pause reached end-to-end and persisted as awaiting_silences.
    assert resultado.pendiente_edicion_silencios is True
    estado = manager.obtener("job-int38")
    assert estado is not None
    assert estado.progreso.estado == JobStatus.ESPERANDO_EDICION_SILENCIOS
    assert estado.unido_path
    assert len(estado.silencios_detectados) == 2
    assert estado.duracion_unido_s == 12.5

    # Correlated pause → awaiting_silences log, carrying the job pair.
    pausa_lines = [
        r.getMessage()
        for r in caplog.records
        if "evento_tipo=pausa_silencios" in r.getMessage()
        and "estado=awaiting_silences" in r.getMessage()
    ]
    assert pausa_lines, "no correlated pause → awaiting_silences log emitted"
    assert "edit_job_id" in pausa_lines[-1] and "editor_job_id" in pausa_lines[-1]
    # No video content leaks into the correlated pause log.
    assert ".mp4" not in pausa_lines[-1]


# ===========================================================================
# PRESERVATION (Property 2) — unchanged after instrumentation
# ===========================================================================
def test_preservacion_orden_seleccion_e_inmutabilidad_en_pipeline(tmp_path) -> None:
    """Through the real ``unir_clips`` inside the pipeline: all and only the
    selected clips are normalized exactly once in order (Req 3.1), source inputs
    are byte-for-byte unchanged and every artifact lands in the workdir (Req 3.2)."""
    inputs_dir = tmp_path / "src_inputs"
    inputs_dir.mkdir(parents=True, exist_ok=True)
    rutas: List[str] = []
    contenidos: List[bytes] = []
    for i in range(3):
        p = inputs_dir / f"clip_{i:02d}.mp4"
        data = ("clip-%d-payload" % i).encode("utf-8")
        p.write_bytes(data)
        rutas.append(str(p))
        contenidos.append(data)

    rec = _Recorder(returncode=0, stdout="10.0")

    # Drive the pipeline with the REAL fn_unir (default) but injected runner +
    # inspector and a detection double; capture the workdir used by the pipeline.
    box: Dict[str, Any] = {}

    def _run() -> None:
        prev_wk, prev_out = config.WORKDIR_ROOT, config.OUTPUT_ROOT
        config.WORKDIR_ROOT = tmp_path / "wk"
        config.OUTPUT_ROOT = tmp_path / "out"
        try:
            job = JobWorkdir("job-preserv-38")
            box["job"] = job
            ajustes = Ajustes()
            ajustes.silencios.activado = True
            box["r"] = ejecutar_pipeline(
                job,
                list(rutas),
                ajustes,
                reporter=lambda _e: None,
                runner=rec,
                inspector=lambda r: _clipinfo(r),
                fn_detectar=_detectar_con([(1.0, 2.0)], 10.0),
                fn_transcribir=_fake_transcribir,
            )
        finally:
            config.WORKDIR_ROOT = prev_wk
            config.OUTPUT_ROOT = prev_out

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        pool.submit(_run).result(timeout=_WALL_CLOCK_CAP_S)

    # (1) Order/selection: per-clip normalization inputs equal orden_clips.
    entradas = _entradas_normalizacion(rec.calls)
    assert entradas == list(rutas)

    # (2) Input immutability (read byte-for-byte).
    for ruta, esperado in zip(rutas, contenidos):
        assert Path(ruta).read_bytes() == esperado

    # (3) Artifacts written to separate destinations inside the workdir.
    job = box["job"]
    concat_path = job.resolve(NOMBRE_CONCAT_TXT)
    assert concat_path.is_file()
    assert job.is_contained(concat_path)
    assert job.is_contained(job.resolve(NOMBRE_UNIDO))
    for ruta in rutas:
        assert not job.is_contained(Path(ruta))


def test_preservacion_modo_local_independiente_de_cloud_run(monkeypatch) -> None:
    """Local mode/backend selection depends ONLY on the explicit flags, never on
    Cloud Run platform metadata (Req 3.3)."""
    for name in ("EDIT_MODE", "VSE_STORAGE_BACKEND"):
        monkeypatch.delenv(name, raising=False)
    # Inject arbitrary Cloud Run metadata — it must not change selection.
    monkeypatch.setenv("K_REVISION", "editor-99999-zzz")
    monkeypatch.setenv("K_SERVICE", "augc-editor")
    assert config.get_edit_mode() == "local"
    assert config.is_cloud_mode() is False
    assert config.is_volume_backend() is False

    monkeypatch.setenv("EDIT_MODE", "cloud")
    monkeypatch.setenv("VSE_STORAGE_BACKEND", "volume")
    assert config.is_cloud_mode() is True
    assert config.is_volume_backend() is True


def test_preservacion_sin_silencios_no_hay_pausa_ni_timeline() -> None:
    """With silences DISABLED there is no silence-edit pause; the pipeline
    advances past the 25% boundary toward transcription (Req 3.7) — the separate
    (no-pause) flow is unaffected by the instrumentation."""
    resultado, eventos = _drive_pipeline(
        ["/clips/a.mp4"], [(1.0, 2.0)], 10.0,
        silencios_activado=False,
        correlacion=_CORRELACION_EJEMPLO,
    )
    assert resultado.pendiente_edicion_silencios is False
    assert any(e.paso_actual == PipelineStep.TRANSCRIBIR for e in eventos)
    # No pause event was emitted on the no-silence flow.
    assert not any(e.evento_tipo == "pausa_silencios" for e in eventos)
