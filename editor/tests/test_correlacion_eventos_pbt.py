"""Task 3.4 — End-to-end correlated events (Property 1) for the ``unir-step-hang``
diagnostic-first bugfix.

**Validates: Requirements 2.1, 2.2, 2.5**

These tests pin the ADDITIVE instrumentation of Task 3.4: every relevant event at
the 25 % boundary carries the end-to-end correlation tuple ``{version, revision,
edit_job_id, editor_job_id}`` plus a differentiated ``subpaso``/``evento_tipo``,
so an affected job is correlatable/classifiable even while the percentage stays
at 25. The percentage stays monotonic and is NEVER used as the state, and no
video content is ever carried in the correlation (only ids/counts/states).

All drives use injected ``fn_unir``/``fn_detectar`` doubles (no real binaries)
under a hard wall-clock cap so the suite can never hang.
"""

from __future__ import annotations

import concurrent.futures
import tempfile
from pathlib import Path
from typing import Any, List, Sequence

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from app import config
from app.engine.pipeline import EventoProgreso, ejecutar_pipeline
from app.engine.silence import ResultadoDeteccionSilencios
from app.models.settings import Ajustes
from app.storage.workdir import JobWorkdir

_WALL_CLOCK_CAP_S: float = 5.0

# Keys the correlation tuple must carry end-to-end (design "Correlation tuple").
_CLAVES_CORRELACION = {"version", "revision", "edit_job_id", "editor_job_id"}


def _fake_unir(job, orden_clips, ancho, alto, fps, *, runner, inspector, **_kw) -> Path:
    return job.resolve("unido.mp4")


def _fake_detectar(unido, *, umbral_db, margen_ms, modo, runner, **_kw):
    return ResultadoDeteccionSilencios(silencios=[(1.0, 2.0)], duracion=10.0)


def _drive(orden_clips: Sequence[str], correlacion: dict) -> List[EventoProgreso]:
    eventos: List[EventoProgreso] = []

    def _run() -> None:
        tmp = Path(tempfile.mkdtemp(prefix="corr-eventos-"))
        prev_wk, prev_out = config.WORKDIR_ROOT, config.OUTPUT_ROOT
        config.WORKDIR_ROOT = tmp / "wk"
        config.OUTPUT_ROOT = tmp / "out"
        try:
            job = JobWorkdir("correlacion-eventos")
            ajustes = Ajustes()  # silencios activados por defecto
            ejecutar_pipeline(
                job,
                list(orden_clips),
                ajustes,
                reporter=eventos.append,
                correlacion=correlacion,
                fn_unir=_fake_unir,
                fn_detectar=_fake_detectar,
            )
        finally:
            config.WORKDIR_ROOT = prev_wk
            config.OUTPUT_ROOT = prev_out

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        pool.submit(_run).result(timeout=_WALL_CLOCK_CAP_S)
    return eventos


def _eventos_25(eventos: Sequence[EventoProgreso]) -> List[EventoProgreso]:
    return [e for e in eventos if e.porcentaje == 25]


_CORRELACION_EJEMPLO = {
    "version": "img-tag v0.9124 mango xD",
    "revision": "editor-00042-abc",
    "edit_job_id": "edit-job-77",
    "editor_job_id": "job_deadbeef",
}


def test_eventos_frontera_25_llevan_correlacion_y_subpaso_diferenciado() -> None:
    """UNIR-done, detection-start and the pause all report 25 % but carry the
    full correlation tuple AND a differentiated subpaso/evento_tipo, so they are
    distinguishable without reading the free-text message."""
    eventos = _drive(["/clips/a.mp4", "/clips/b.mp4"], _CORRELACION_EJEMPLO)
    en_25 = _eventos_25(eventos)

    assert len(en_25) >= 3, "expected several distinct substeps at 25%"

    # Every 25% event carries the full correlation tuple (Req 2.5).
    for ev in en_25:
        assert ev.correlacion is not None
        assert _CLAVES_CORRELACION.issubset(ev.correlacion.keys())
        assert ev.correlacion["edit_job_id"] == "edit-job-77"
        assert ev.correlacion["editor_job_id"] == "job_deadbeef"

    # The three boundary events are differentiated by structured metadata
    # (subpaso + evento_tipo), NOT by the message (Req 2.2).
    tipos = {e.evento_tipo for e in en_25}
    assert {"unir_fin", "deteccion_inicio", "pausa_silencios"}.issubset(tipos)
    firmas = {(e.evento_tipo, e.subpaso) for e in en_25}
    assert len(firmas) >= 3


def test_correlacion_no_lleva_contenido_de_video() -> None:
    """The correlation carried by every event contains only id/state keys — no
    video content, paths, or bytes (Req 2.5)."""
    eventos = _drive(["/clips/a.mp4", "/clips/b.mp4"], _CORRELACION_EJEMPLO)
    for ev in eventos:
        if ev.correlacion is None:
            continue
        assert set(ev.correlacion.keys()) <= _CLAVES_CORRELACION
        blob = repr(ev.correlacion).lower()
        assert ".mp4" not in blob
        assert "video" not in blob


@settings(
    max_examples=30,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture, HealthCheck.too_slow],
)
@given(
    n_clips=st.integers(min_value=2, max_value=5),
    edit_job_id=st.text(
        alphabet=st.characters(min_codepoint=97, max_codepoint=122), min_size=1, max_size=10
    ),
    editor_job_id=st.text(
        alphabet=st.characters(min_codepoint=97, max_codepoint=122), min_size=1, max_size=10
    ),
)
def test_propiedad_estado_cambia_con_porcentaje_25_monotono(
    n_clips: int, edit_job_id: str, editor_job_id: str
) -> None:
    """Property: step/substep/state may change while the percentage stays at 25
    and stays monotonic non-decreasing, and every boundary event carries the
    same correlation (independent of the percentage)."""
    correlacion = {
        "version": "v",
        "revision": "r",
        "edit_job_id": edit_job_id,
        "editor_job_id": editor_job_id,
    }
    orden = ["/clips/clip_%02d.mp4" % i for i in range(n_clips)]
    eventos = _drive(orden, correlacion)

    # Percentage monotonic non-decreasing.
    porcentajes = [e.porcentaje for e in eventos]
    for anterior, siguiente in zip(porcentajes, porcentajes[1:]):
        assert siguiente >= anterior

    en_25 = _eventos_25(eventos)
    assert len(en_25) >= 3
    # Substep/evento_tipo/state vary while the percentage is pinned at 25.
    assert len({(e.evento_tipo, e.subpaso) for e in en_25}) >= 3
    # Correlation is stable and carries the exact ids across the boundary.
    for ev in en_25:
        assert ev.correlacion["edit_job_id"] == edit_job_id
        assert ev.correlacion["editor_job_id"] == editor_job_id
