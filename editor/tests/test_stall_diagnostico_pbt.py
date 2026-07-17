"""Task 1.1 — Reproducible bug-condition diagnostic (Property 1) for the
UNIR / CORTAR_SILENCIOS **opaque stall at 25 %** (spec ``unir-step-hang``).

**Validates: Requirements 1.2, 1.3, 1.5**

Methodology (bug-condition, order is mandatory)
-----------------------------------------------
This is an **exploratory bug-condition check** written *BEFORE* any
instrumentation (Task 1, design §"Exploratory Bug Condition Checking", case 1).
It encodes the **expected post-fix diagnosability** at the 25 % boundary and is
therefore **EXPECTED TO FAIL on the CURRENT (un-instrumented) code** — that
failure *confirms* the bug. Per the workflow, the production code and this test
MUST NOT be "fixed" to make it pass here; the very same test is re-run later
(Task 3.9) and is expected to PASS once the differentiated, correlated events of
Task 3 are in place.

Observed counterexample on the CURRENT code (the documented gap)
----------------------------------------------------------------
Driving :func:`app.engine.pipeline.ejecutar_pipeline` with silences **enabled**
(default) and injected ``fn_unir`` / ``fn_detectar`` doubles (no real ffmpeg /
ffprobe / auto-editor binaries) produces this progress trail — note that the
last **three** events all report **percentage 25**::

    EventoProgreso(estado=en_ejecucion, indice_paso=1, paso_actual=UNIR,
                   porcentaje=0,  mensaje="Uniendo y normalizando clips a 9:16")
    EventoProgreso(estado=en_ejecucion, indice_paso=1, paso_actual=UNIR,
                   porcentaje=25, mensaje="Clips unidos")               # UNIR done
    EventoProgreso(estado=en_ejecucion, indice_paso=2, paso_actual=CORTAR_SILENCIOS,
                   porcentaje=25, mensaje="Detectando silencios")       # detection start
    EventoProgreso(estado=en_ejecucion, indice_paso=2, paso_actual=CORTAR_SILENCIOS,
                   porcentaje=25, mensaje="Esperando edición manual de silencios")  # pause

From this trail an observer **cannot** classify the job into exactly one of the
four categories A/B/C/D of the design's "Diagnostic Decision Matrix" because:

* **No "silence-detection done" event is emitted at all** — detection-start is
  immediately followed by the pause, so category B ("detection blocked") cannot
  be distinguished from category C ("detection done, pause not propagated").
* ``EventoProgreso`` exposes only ``{estado, indice_paso, paso_actual,
  porcentaje, mensaje, error}`` — there is **no** ``subpaso``, **no** structured
  ``evento_tipo`` (eventType), and **no** correlation tuple (version, revision,
  ``editJobId``, ``editorJobId``). The detection-start and pause events are
  therefore identical on every *structured* field and differ only by the
  free-text ``mensaje`` (Spanish prose), which the design forbids using as the
  state.
* Multiple distinct substeps share the value 25, and the percentage is (rightly)
  monotonic — so the percentage carries no diagnostic signal (Req 1.2).

These three facts are exactly requirements 1.2 (percentage 25 tells you nothing),
1.3 (the job cannot be classified A/B/C/D) and 1.5 (no correlated end-to-end
record). The assertions below encode the *fixed* contract and consequently fail
on the current code, surfacing the counterexample above.
"""

from __future__ import annotations

import concurrent.futures
import dataclasses
import tempfile
from pathlib import Path
from typing import Any, List, Optional, Sequence, Tuple

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from app import config
from app.engine.pipeline import EventoProgreso, ejecutar_pipeline
from app.engine.silence import ResultadoDeteccionSilencios
from app.models.settings import Ajustes
from app.storage.workdir import JobWorkdir

# Hard wall-clock cap (seconds) for every pipeline drive, so a real hang can
# never wedge the suite (design: "each guarded by a hard wall-clock cap so the
# suite never hangs"). The injected doubles are instantaneous; the cap only
# guards against regressions that introduce a genuine block.
_WALL_CLOCK_CAP_S: float = 5.0

# The four diagnostic categories of the design's "Diagnostic Decision Matrix".
_CATEGORIAS = frozenset({"A", "B", "C", "D"})

# Post-fix correlation-tuple keys every diagnostic event must carry so an
# affected job can be correlated end-to-end (Req 1.5, 2.5; design "Correlation
# tuple"). The container is expected on the event as a ``correlacion`` mapping.
_CLAVES_CORRELACION = frozenset(
    {"version", "revision", "edit_job_id", "editor_job_id"}
)

# The four differentiated event kinds that must be observable around the 25 %
# boundary (design "Change 4 / Correctness Properties / Property 1").
_TIPOS_FRONTERA_ESPERADOS = frozenset(
    {"unir_fin", "deteccion_inicio", "deteccion_fin", "pausa_silencios"}
)


# ---------------------------------------------------------------------------
# Injected doubles (no real binaries) — Req 3.3 / design "injected doubles"
# ---------------------------------------------------------------------------
def _fake_unir(
    job: JobWorkdir,
    orden_clips: Sequence[str],
    ancho: int,
    alto: int,
    fps: int,
    *,
    runner: Any,
    inspector: Any,
    **_kw: Any,
) -> Path:
    """Stand-in for ``unir_clips`` that never invokes ffmpeg/ffprobe."""
    return job.resolve("unido.mp4")


def _fake_detectar(
    unido: Any,
    *,
    umbral_db: float,
    margen_ms: float,
    modo: str,
    runner: Any,
    **_kw: Any,
) -> ResultadoDeteccionSilencios:
    """Stand-in for ``detectar_silencios`` returning deterministic segments."""
    return ResultadoDeteccionSilencios(silencios=[(1.0, 2.0)], duracion=10.0)


def _detectar_con(
    silencios: List[Tuple[float, float]], duracion: float
):
    def _fake(unido, *, umbral_db, margen_ms, modo, runner, **_kw):
        return ResultadoDeteccionSilencios(
            silencios=list(silencios), duracion=duracion
        )

    return _fake


def _drive_pipeline(
    orden_clips: Sequence[str],
    fn_detectar,
) -> List[EventoProgreso]:
    """Run ``ejecutar_pipeline`` (silences enabled) under a wall-clock cap.

    Uses an isolated temp workdir/output root and injected doubles so no real
    binaries run. Returns the captured ``EventoProgreso`` trail.
    """
    eventos: List[EventoProgreso] = []

    def _run() -> None:
        tmp = Path(tempfile.mkdtemp(prefix="stall-diag-"))
        prev_wk, prev_out = config.WORKDIR_ROOT, config.OUTPUT_ROOT
        config.WORKDIR_ROOT = tmp / "wk"
        config.OUTPUT_ROOT = tmp / "out"
        try:
            job = JobWorkdir("stall-diagnostico")
            ajustes = Ajustes()  # silencios.activado == True by default (Req 1.x)
            assert ajustes.silencios.activado is True
            ejecutar_pipeline(
                job,
                list(orden_clips),
                ajustes,
                reporter=eventos.append,
                fn_unir=_fake_unir,
                fn_detectar=fn_detectar,
            )
        finally:
            config.WORKDIR_ROOT = prev_wk
            config.OUTPUT_ROOT = prev_out

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        pool.submit(_run).result(timeout=_WALL_CLOCK_CAP_S)
    return eventos


# ---------------------------------------------------------------------------
# Structured-metadata accessors (post-fix contract; absent on current code)
# ---------------------------------------------------------------------------
def _subpaso(ev: EventoProgreso) -> Optional[str]:
    valor = getattr(ev, "subpaso", None)
    return valor if isinstance(valor, str) and valor.strip() else None


def _evento_tipo(ev: EventoProgreso) -> Optional[str]:
    valor = getattr(ev, "evento_tipo", getattr(ev, "event_type", None))
    return valor if isinstance(valor, str) and valor.strip() else None


def _correlacion(ev: EventoProgreso) -> Optional[dict]:
    valor = getattr(ev, "correlacion", None)
    return valor if isinstance(valor, dict) else None


def _tiene_correlacion_completa(ev: EventoProgreso) -> bool:
    corr = _correlacion(ev)
    if corr is None:
        return False
    return _CLAVES_CORRELACION.issubset(corr.keys())


def _eventos_en_25(trail: Sequence[EventoProgreso]) -> List[EventoProgreso]:
    return [e for e in trail if e.porcentaje == 25]


def _render_trail(trail: Sequence[EventoProgreso]) -> str:
    """Human-readable dump of the trail, embedded in failure messages so the
    counterexample is visible when the diagnosability contract is not met."""
    lineas = []
    for e in trail:
        lineas.append(
            "  estado=%s idx=%s paso=%s pct=%s subpaso=%r evento_tipo=%r "
            "correlacion=%r mensaje=%r"
            % (
                e.estado.value,
                e.indice_paso,
                e.paso_actual.value if e.paso_actual else None,
                e.porcentaje,
                _subpaso(e),
                _evento_tipo(e),
                _correlacion(e),
                e.mensaje,
            )
        )
    return "\n".join(lineas)


def clasificar_ultimo_evento(trail: Sequence[EventoProgreso]) -> Optional[str]:
    """Map the **last confirmed correlated event** to exactly one of A/B/C/D.

    Post-fix classifier that relies ONLY on *structured* metadata (the
    ``evento_tipo`` of the differentiated events), never on the free-text
    ``mensaje``. On the current code every ``evento_tipo`` is ``None`` (the field
    does not exist), so this returns ``None`` — i.e. the job is un-classifiable,
    which is the bug (Req 1.3).
    """
    tipos_vistos = [t for t in (_evento_tipo(e) for e in trail) if t is not None]
    if not tipos_vistos:
        return None
    ultimo = tipos_vistos[-1]
    # UNIR substeps started but never finished -> ffmpeg/ffprobe blocked (A).
    if ultimo in {"unir_inicio", "ffprobe_inicio", "normalizar_inicio", "concat_inicio"}:
        return "A"
    # UNIR done, detection started but not finished -> detection blocked (B).
    if ultimo in {"unir_fin", "deteccion_inicio"}:
        return "B"
    # Detection finished / pause reached -> pause not propagated (C).
    if ultimo in {"deteccion_fin", "pausa_silencios"}:
        return "C"
    if ultimo in {"identidad_mismatch"}:
        return "D"
    return None


# ---------------------------------------------------------------------------
# Deterministic boundary case (design "Exploratory Bug Condition Checking" #1)
# ---------------------------------------------------------------------------
def test_frontera_25_no_es_diferenciable_ni_correlacionable() -> None:
    """At 25 %, UNIR-done / detection-start / detection-done / pause must be
    differentiated and carry the full correlation tuple so the job is
    classifiable into exactly one of A/B/C/D.

    EXPECTED ON CURRENT CODE: **fails** — no ``subpaso`` / ``evento_tipo`` /
    ``correlacion`` fields exist and no "detection done" event is emitted, so the
    last confirmed event cannot place the job into a single category.
    """
    trail = _drive_pipeline(["/clips/a.mp4", "/clips/b.mp4"], _fake_detectar)
    dump = _render_trail(trail)

    # The boundary genuinely piles multiple distinct substeps onto pct 25
    # (this part is true today and remains true — the percentage is monotonic
    # and carries no diagnostic signal, Req 1.2, 3.8).
    en_25 = _eventos_en_25(trail)
    assert len(en_25) >= 3, (
        "expected several distinct substeps sharing percentage 25\n" + dump
    )

    # (Req 2.1 / Property 1) The four boundary substeps must be observable as
    # DIFFERENTIATED structured event kinds — including a silence-detection-DONE
    # event, which the current pipeline never emits.
    tipos_frontera = {t for t in (_evento_tipo(e) for e in en_25) if t}
    assert _TIPOS_FRONTERA_ESPERADOS.issubset(tipos_frontera), (
        "the 25%% boundary must emit differentiated events "
        "%s; observed structured event kinds: %s\n%s"
        % (sorted(_TIPOS_FRONTERA_ESPERADOS), sorted(tipos_frontera), dump)
    )

    # (Req 1.5 / 2.5) Every boundary event must carry the full correlation tuple
    # and a non-empty substep so it is correlatable end-to-end.
    for ev in en_25:
        assert _subpaso(ev) is not None, (
            "boundary event lacks a structured 'subpaso'\n" + dump
        )
        assert _tiene_correlacion_completa(ev), (
            "boundary event lacks the correlation tuple %s\n%s"
            % (sorted(_CLAVES_CORRELACION), dump)
        )

    # (Req 1.3) The last confirmed event must classify the job into A/B/C/D.
    categoria = clasificar_ultimo_evento(trail)
    assert categoria in _CATEGORIAS, (
        "last confirmed event is NOT classifiable into one of A/B/C/D "
        "(got %r) — this is the opaque-25%% stall\n%s" % (categoria, dump)
    )


def test_deteccion_inicio_y_pausa_son_distinguibles_sin_texto_libre() -> None:
    """The silence-detection-start and the ``ESPERANDO_EDICION_SILENCIOS`` pause
    must be distinguishable by *structured* metadata (``subpaso`` /
    ``evento_tipo``) — NOT by the free-text ``mensaje``.

    EXPECTED ON CURRENT CODE: **fails** — both events share
    ``estado``/``indice_paso``/``paso_actual``/``porcentaje`` and differ only in
    the Spanish ``mensaje`` prose (design forbids using the message as state).
    """
    trail = _drive_pipeline(["/clips/a.mp4", "/clips/b.mp4"], _fake_detectar)
    dump = _render_trail(trail)
    en_25 = _eventos_en_25(trail)

    firmas_estructuradas = {
        (
            e.estado.value,
            e.indice_paso,
            e.paso_actual.value if e.paso_actual else None,
            e.porcentaje,
            _subpaso(e),
            _evento_tipo(e),
        )
        for e in en_25
    }
    assert len(firmas_estructuradas) == len(en_25), (
        "structured signatures of the 25%% events collide — detection-start and "
        "the pause are indistinguishable without reading the free-text message\n"
        + dump
    )


# ---------------------------------------------------------------------------
# Scoped property (deterministic gap; small strategy + wall-clock cap)
# ---------------------------------------------------------------------------
@settings(
    max_examples=25,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture],
)
@given(
    n_clips=st.integers(min_value=2, max_value=5),
    n_silencios=st.integers(min_value=0, max_value=3),
)
def test_propiedad_diagnosabilidad_en_frontera_25(
    n_clips: int, n_silencios: int
) -> None:
    """For any small selection of clips and any number of detected silence
    segments, the pipeline at the 25 % boundary must still be diagnosable:
    differentiated, correlated events that classify the job into A/B/C/D,
    independent of the (monotonic) percentage.

    EXPECTED ON CURRENT CODE: **fails** for every example — the diagnosability
    gap is deterministic (not input-dependent).
    """
    orden = ["/clips/clip_%02d.mp4" % i for i in range(n_clips)]
    silencios = [(float(i), float(i) + 0.5) for i in range(n_silencios)]
    trail = _drive_pipeline(orden, _detectar_con(silencios, 10.0))
    dump = _render_trail(trail)

    # Sanity: the drive reached the 25% boundary (UNIR done + detection + pause).
    assert _eventos_en_25(trail), "pipeline never reached the 25%% boundary\n" + dump

    # The classification must succeed from structured metadata alone.
    categoria = clasificar_ultimo_evento(trail)
    assert categoria in _CATEGORIAS, (
        "job at 25%% not classifiable into A/B/C/D from correlated events "
        "(got %r; n_clips=%d, n_silencios=%d)\n%s"
        % (categoria, n_clips, n_silencios, dump)
    )
