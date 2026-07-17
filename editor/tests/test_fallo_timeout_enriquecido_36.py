"""Task 3.6 — Preserve and enrich the terminal timeout failure (Property 5) for
the ``unir-step-hang`` diagnostic-first bugfix.

**Validates: Requirements 2.7, 3.5**

These tests pin the ADDITIVE behaviour of Task 3.6: the existing terminal-failure
chain ``ComandoTimeoutError`` → step-specific error → ``FALLIDO {paso, motivo}``
is kept **intact** (Preservation, Property 5) while the failure is **enriched**
so a terminal timeout is immediately localizable end-to-end:

* an injected :class:`ComandoTimeoutError` during the UNIR step still drives the
  pipeline to an unsuccessful :class:`ResultadoPipeline` with
  ``paso_fallido == UNIR`` and a single ``FALLIDO`` event whose actionable
  ``error`` carries ``{paso: "UNIR", subpaso, motivo}`` plus the correlation
  tuple (Req 2.7);
* the enriched ``motivo`` still contains the original, actionable timeout text
  (``plazo``) — no timeout values are introduced or assumed (Req 3.5) — and it is
  localizable (carries the substep + correlation) so it survives the Job
  manager's ``{paso, motivo}`` reconstruction;
* no partial ``unido.mp4`` is left referenced as success (no COMPLETADO event, no
  final video path, no artifact on disk);
* video content is NEVER logged (the correlation only carries the four canonical
  id/state keys).

All drives use injected doubles (no real binaries) under a hard wall-clock cap so
the suite can never hang.
"""

from __future__ import annotations

import concurrent.futures
from pathlib import Path
from typing import List

import pytest

from app import config
from app.engine.normalize import NOMBRE_UNIDO
from app.engine.pipeline import EventoProgreso, ejecutar_pipeline
from app.engine.proc import ComandoTimeoutError
from app.models.job import JobStatus, PipelineStep
from app.models.settings import Ajustes
from app.storage.workdir import JobWorkdir

_WALL_CLOCK_CAP_S: float = 5.0

# The four canonical correlation-tuple keys every enriched failure must carry.
_CLAVES_CORRELACION = {"version", "revision", "edit_job_id", "editor_job_id"}

_CORRELACION_EJEMPLO = {
    "version": "img-tag v0.9124 mango xD",
    "revision": "editor-00042-abc",
    "edit_job_id": "edit-job-77",
    "editor_job_id": "job_deadbeef",
}


@pytest.fixture(autouse=True)
def _isolate_workdir(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "WORKDIR_ROOT", tmp_path / "wk")
    monkeypatch.setattr(config, "OUTPUT_ROOT", tmp_path / "out")


def _fn_unir_timeout(job, orden_clips, ancho, alto, fps, *, runner, inspector, **_kw) -> Path:
    """A UNIR double that always times out (as the bounded executor would).

    Raises the SAME ``ComandoTimeoutError`` the real executor raises on a hang;
    no new timeout value is introduced — the plazo is carried by the error.
    """
    raise ComandoTimeoutError(["ffmpeg", "-i", "in", "out"], 60.0, "ffmpeg stderr tail...")


def _drive_hasta_fallo() -> tuple:
    """Run ``ejecutar_pipeline`` with the timing-out UNIR double under a cap."""
    eventos: List[EventoProgreso] = []
    holder: dict = {}

    def _run() -> None:
        job = JobWorkdir("job-unir-timeout-36")
        holder["job"] = job
        holder["resultado"] = ejecutar_pipeline(
            job,
            ["/clips/a.mp4", "/clips/b.mp4"],
            Ajustes(),  # silences enabled by default; UNIR fails before it matters
            reporter=eventos.append,
            correlacion=dict(_CORRELACION_EJEMPLO),
            fn_unir=_fn_unir_timeout,
        )

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        pool.submit(_run).result(timeout=_WALL_CLOCK_CAP_S)
    return holder["resultado"], eventos, holder["job"]


def test_timeout_unir_produce_fallido_paso_subpaso_motivo_correlacionado() -> None:
    """An injected ComandoTimeoutError during UNIR -> FALLIDO {paso:UNIR, subpaso,
    motivo} with correlation; no partial unido.mp4 referenced as success."""
    resultado, eventos, job = _drive_hasta_fallo()

    # The chain is preserved: unsuccessful result stopped at UNIR.
    assert resultado.exito is False
    assert resultado.paso_fallido == PipelineStep.UNIR
    assert resultado.motivo

    # Exactly one FALLIDO event, at UNIR, carrying {paso, subpaso, motivo}.
    fallidos = [e for e in eventos if e.estado == JobStatus.FALLIDO]
    assert len(fallidos) == 1
    fallo = fallidos[0]
    assert fallo.paso_actual == PipelineStep.UNIR
    assert fallo.evento_tipo == "fallo"
    assert fallo.error is not None
    assert fallo.error["paso"] == PipelineStep.UNIR.value
    # The subpaso localizes the failure inside UNIR.
    assert fallo.error.get("subpaso")
    assert fallo.subpaso == fallo.error["subpaso"]

    # The actionable timeout text survives the wrapping (no timeout value invented).
    assert "plazo" in fallo.error["motivo"].lower()

    # The failure is enriched with the correlation tuple, both on the event and
    # inside the error, so it is localizable end-to-end.
    assert fallo.correlacion is not None
    assert _CLAVES_CORRELACION.issubset(fallo.correlacion.keys())
    assert fallo.correlacion["edit_job_id"] == "edit-job-77"
    assert fallo.correlacion["editor_job_id"] == "job_deadbeef"
    assert "correlacion" in fallo.error
    assert _CLAVES_CORRELACION.issubset(fallo.error["correlacion"].keys())


def test_motivo_localizable_sobrevive_reconstruccion_del_gestor() -> None:
    """The enriched ``motivo`` string itself carries the substep + correlation, so
    it stays localizable even after the manager rebuilds ``{paso, motivo}``."""
    resultado, eventos, _job = _drive_hasta_fallo()
    fallo = next(e for e in eventos if e.estado == JobStatus.FALLIDO)

    # ResultadoPipeline.motivo (what the runner forwards to marcar_fallido) equals
    # the enriched, localizable motivo of the error.
    assert resultado.motivo == fallo.error["motivo"]
    # The motivo text embeds the substep and the correlation identifiers, so a
    # terminal failure is localizable reading only the motivo.
    assert "subpaso=" in resultado.motivo
    assert "correlacion=" in resultado.motivo
    assert "edit-job-77" in resultado.motivo


def test_ningun_unido_parcial_referenciado_como_exito() -> None:
    """No partial ``unido.mp4`` is produced/referenced as success on a UNIR timeout."""
    resultado, eventos, job = _drive_hasta_fallo()

    # No success signalling of any kind.
    assert resultado.exito is False
    assert resultado.ruta_video_final is None
    assert not any(e.estado == JobStatus.COMPLETADO for e in eventos)
    # No step after UNIR ran and no partial joined artifact exists on disk.
    assert all(e.paso_actual == PipelineStep.UNIR for e in eventos)
    assert not job.resolve(NOMBRE_UNIDO).exists()


def test_correlacion_del_fallo_no_lleva_contenido_de_video() -> None:
    """The failure correlation only carries the four canonical id/state keys."""
    _resultado, eventos, _job = _drive_hasta_fallo()
    fallo = next(e for e in eventos if e.estado == JobStatus.FALLIDO)

    assert set(fallo.correlacion.keys()) <= _CLAVES_CORRELACION
    assert set(fallo.error["correlacion"].keys()) <= _CLAVES_CORRELACION
    blob = repr(fallo.error["correlacion"]).lower()
    assert ".mp4" not in blob and "video" not in blob
