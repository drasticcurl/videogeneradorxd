"""Integration test: a UNIR-step subprocess timeout propagates to FALLIDO.

Bugfix spec ``unir-step-hang``, Task 6.5. Verifies (no new production code beyond
``ComandoTimeoutError`` deriving from ``OSError``) that a timeout raised by an
external tool during the UNIR step is wrapped into the step-specific error
(``NormalizacionError``) and routed by the pipeline to a ``FALLIDO`` event with an
actionable ``error = {"paso": "UNIR", "motivo": ...}``, that
``ResultadoPipeline.exito is False``, and that no partial ``unido.mp4`` is left
referenced as success (Req 2.3, 2.6).

Validates: Requirements 2.3, 2.6
"""

from __future__ import annotations

from typing import List

import pytest

from app import config
from app.engine.ffprobe import ClipInfo
from app.engine.normalize import NOMBRE_UNIDO
from app.engine.pipeline import EventoProgreso, ejecutar_pipeline
from app.engine.proc import ComandoTimeoutError
from app.models.job import JobStatus, PipelineStep
from app.models.settings import Ajustes
from app.storage.workdir import JobWorkdir


@pytest.fixture(autouse=True)
def _isolate_workdir(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "WORKDIR_ROOT", tmp_path / "wk")
    monkeypatch.setattr(config, "OUTPUT_ROOT", tmp_path / "out")


def _inspector_ok(ruta: str) -> ClipInfo:
    """A valid clip so inspection passes; the timeout fires at normalization."""
    return ClipInfo(
        ruta=ruta, ancho=1080, alto=1920, rotacion=0, fps=30.0,
        duracion_s=8.0, tiene_video=True, tiene_audio=True,
    )


def _runner_timeout(args, timeout=None):
    """A runner that always times out (as the real executor would on a hang)."""
    raise ComandoTimeoutError(args, timeout if timeout is not None else 60.0,
                              "ffmpeg stderr tail...")


def test_unir_timeout_propaga_a_fallido() -> None:
    """A ComandoTimeoutError during UNIR -> FALLIDO {paso: UNIR, motivo}, no partial output."""
    eventos: List[EventoProgreso] = []
    job = JobWorkdir("job-unir-timeout")

    resultado = ejecutar_pipeline(
        job,
        ["/clips/a.mp4", "/clips/b.mp4"],
        Ajustes(),
        reporter=eventos.append,
        runner=_runner_timeout,
        inspector=_inspector_ok,
    )

    # The pipeline stops with an unsuccessful result at UNIR.
    assert resultado.exito is False
    assert resultado.paso_fallido == PipelineStep.UNIR
    assert resultado.motivo

    # A FALLIDO event was reported with an actionable {paso, motivo} at UNIR.
    fallidos = [e for e in eventos if e.estado == JobStatus.FALLIDO]
    assert len(fallidos) == 1
    fallo = fallidos[0]
    assert fallo.paso_actual == PipelineStep.UNIR
    assert fallo.error is not None
    assert fallo.error["paso"] == PipelineStep.UNIR.value
    assert fallo.error["motivo"]
    # The actionable timeout message survives the wrapping into NormalizacionError.
    assert "plazo" in fallo.error["motivo"].lower()

    # No steps after UNIR ran (no CORTAR_SILENCIOS event) and no partial output.
    assert all(e.paso_actual == PipelineStep.UNIR for e in eventos)
    assert not job.resolve(NOMBRE_UNIDO).exists()
