"""Task 2 (Property 2: Preservation) — observation-first baselines for the
``unir-step-hang`` diagnostic-first bugfix.

**Validates: Requirements 3.1, 3.2, 3.6, 3.8**

These properties pin the CURRENT observable behavior that the (still-to-come)
instrumentation of Task 3 MUST NOT change. They are **observation-first**: each
was run against the un-instrumented code first and then encoded, so every test
here is **EXPECTED TO PASS on the CURRENT (un-instrumented) code** and to keep
passing after the additive, observation-only diagnostics land (Task 3.10).

Covered preservation invariants (design §"Preservation Requirements",
§"Preservation Checking", §"Property-Based Tests / Order preservation"):

* **Order / selection (Req 3.1):** ``contenido_concat_txt`` / ``parsear_concat_txt``
  round-trip element-for-element, and ``unir_clips`` normalizes **all and only**
  the selected clips **exactly once, in the requested order** (the per-clip
  ``ffmpeg -i <clip>`` inputs equal ``orden_clips``).
* **Input immutability / separate destinations (Req 3.2):** real source files
  fed to ``unir_clips`` are left byte-for-byte unchanged; every artifact
  (``concat.txt``, the intermediates, ``unido.mp4``) is written **inside the job
  workdir**, i.e. to destinations separate from the inputs.
* **Pause semantics (Req 3.6, 3.7):** with silences ENABLED the pipeline pauses
  (``pendiente_edicion_silencios``), preserving the joined video and the detected
  segments and NOT starting transcription; with silences DISABLED there is no
  pause (it proceeds past the 25 % boundary).
* **Monotonic percentage; state ⟂ percentage (Req 3.8):** the reported progress
  percentage is monotonic non-decreasing, and several distinct substeps share
  the value 25 (the step/substep/message change while the percentage does not).

All drives use injected ``fn_unir`` / ``fn_detectar`` doubles and recording
``Runner`` doubles — **no real ffmpeg / ffprobe / auto-editor binaries** — and a
hard wall-clock cap so the suite can never hang (Req 3.3, design "hard
wall-clock cap").

EXPECTED OUTCOME on UNFIXED code: PASS.
"""

from __future__ import annotations

import concurrent.futures
import tempfile
from pathlib import Path
from typing import Any, List, Sequence

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from app import config
from app.engine.ffprobe import ClipInfo
from app.engine.normalize import (
    NOMBRE_CONCAT_TXT,
    NOMBRE_UNIDO,
    contenido_concat_txt,
    orden_concatenacion,
    parsear_concat_txt,
    unir_clips,
)
from app.engine.pipeline import EventoProgreso, ejecutar_pipeline
from app.engine.proc import ResultadoComando
from app.engine.silence import ResultadoDeteccionSilencios
from app.models.job import JobStatus, PipelineStep
from app.models.settings import Ajustes
from app.storage.workdir import JobWorkdir

# Hard wall-clock cap (seconds) for every pipeline drive. The injected doubles
# are instantaneous; this only guards against a regression introducing a genuine
# block, so the suite can never wedge.
_WALL_CLOCK_CAP_S: float = 5.0

_PBT = settings(
    max_examples=60,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture, HealthCheck.too_slow],
)


# ---------------------------------------------------------------------------
# Recording Runner double (never invokes real binaries; records command args)
# ---------------------------------------------------------------------------
class _Recorder:
    def __init__(self, returncode: int = 0, stdout: str = "", stderr: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        self.calls: List[List[str]] = []

    def __call__(self, args):  # genuine single-arg Runner shape
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
    """Extract the source clip of each per-clip normalization command in order.

    A normalization command contains ``-map`` and one or more ``-i`` inputs; the
    real source clip is the argument that follows the LAST ``-i`` (an
    ``anullsrc`` input may precede it when the clip lacks audio).
    """
    entradas: List[str] = []
    for cmd in calls:
        cmd = list(cmd)
        if "-map" not in cmd or "-i" not in cmd:
            continue
        idx = len(cmd) - 1 - cmd[::-1].index("-i")
        entradas.append(cmd[idx + 1])
    return entradas


@pytest.fixture()
def _isolate_roots(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "WORKDIR_ROOT", tmp_path / "wk")
    monkeypatch.setattr(config, "OUTPUT_ROOT", tmp_path / "out")
    return tmp_path


# Clip-order strategy: 1..6 distinct, filesystem-friendly references.
def _rutas() -> st.SearchStrategy[List[str]]:
    ref = st.text(
        alphabet=st.characters(min_codepoint=97, max_codepoint=122),
        min_size=1,
        max_size=8,
    ).map(lambda s: f"/clips/{s}.mp4")
    return st.lists(ref, min_size=1, max_size=6)


# ===========================================================================
# Order / selection preservation (Req 3.1) — pure round-trip
# ===========================================================================
# Clip references excluding control/surrogate categories and newlines, matching
# the proven-safe alphabet the concat demuxer round-trip supports (see
# test_ordering.py): ``splitlines``/``strip`` treat several C0/C1 control chars
# as line boundaries, so they are (correctly) outside the supported reference
# space for a ``concat.txt`` line.
def _referencia_clip() -> st.SearchStrategy[str]:
    return st.text(
        alphabet=st.characters(blacklist_categories=("Cc", "Cs"), blacklist_characters="\n\r"),
        min_size=1,
        max_size=30,
    )


@_PBT
@given(orden=st.lists(_referencia_clip(), min_size=1, max_size=200))
def test_concat_round_trip_elemento_a_elemento(orden: List[str]) -> None:
    """``concat.txt`` reproduces the exact order element-for-element; never
    reorders, drops or duplicates a clip."""
    assert orden_concatenacion(orden) == orden
    recuperado = parsear_concat_txt(contenido_concat_txt(orden))
    assert recuperado == orden
    assert len(recuperado) == len(orden)
    for esperado, obtenido in zip(orden, recuperado):
        assert obtenido == esperado


# ===========================================================================
# Order / selection preservation through unir_clips (Req 3.1)
# ===========================================================================
@_PBT
@given(rutas=_rutas(), tiene_audio=st.booleans())
def test_unir_normaliza_todos_y_solo_en_orden(
    rutas: List[str], tiene_audio: bool, _isolate_roots
) -> None:
    """``unir_clips`` normalizes all and only the selected clips, exactly once,
    in the requested order (the per-clip ``-i`` inputs equal ``orden_clips``)."""
    job = JobWorkdir("job-orden")
    rec = _Recorder(returncode=0)
    unir_clips(job, rutas, 1080, 1920, 30, runner=rec,
               inspector=lambda r: _clipinfo(r, audio=tiene_audio))

    entradas = _entradas_normalizacion(rec.calls)
    # All and only the selected clips, exactly once, in order.
    assert entradas == list(rutas)


# ===========================================================================
# Input immutability + separate destinations (Req 3.2)
# ===========================================================================
@_PBT
@given(n=st.integers(min_value=1, max_value=5))
def test_inputs_inmutables_y_destinos_separados(n: int, _isolate_roots) -> None:
    """Source files are read byte-for-byte (unchanged) and every artifact lands
    inside the job workdir — a destination separate from the inputs."""
    tmp_path: Path = _isolate_roots
    inputs_dir = tmp_path / "src_inputs"
    inputs_dir.mkdir(parents=True, exist_ok=True)

    rutas: List[str] = []
    contenidos: List[bytes] = []
    for i in range(n):
        p = inputs_dir / f"clip_{i:02d}.mp4"
        data = ("clip-%d-payload" % i).encode("utf-8")
        p.write_bytes(data)
        rutas.append(str(p))
        contenidos.append(data)

    job = JobWorkdir("job-inmutable")
    rec = _Recorder(returncode=0)
    salida = unir_clips(job, rutas, 1080, 1920, 30, runner=rec,
                        inspector=lambda r: _clipinfo(r))

    # (1) Inputs are byte-for-byte unchanged (read-only).
    for ruta, esperado in zip(rutas, contenidos):
        assert Path(ruta).read_bytes() == esperado

    # (2) Artifacts are written to separate destinations inside the workdir.
    concat_path = job.resolve(NOMBRE_CONCAT_TXT)
    assert concat_path.is_file()
    assert job.is_contained(concat_path)
    assert salida == job.resolve(NOMBRE_UNIDO)
    assert job.is_contained(salida)
    # No artifact path collides with any input path.
    for ruta in rutas:
        assert Path(ruta).resolve() != concat_path.resolve()
        assert Path(ruta).resolve() != salida.resolve()
        # Inputs live outside the workdir.
        assert not job.is_contained(Path(ruta))


# ---------------------------------------------------------------------------
# Pipeline drive helper (silences configurable) under a wall-clock cap
# ---------------------------------------------------------------------------
def _fake_unir(job: JobWorkdir, orden_clips, ancho, alto, fps, *, runner, inspector, **_kw) -> Path:
    return job.resolve("unido.mp4")


def _fake_detectar(unido, *, umbral_db, margen_ms, modo, runner, **_kw) -> ResultadoDeteccionSilencios:
    return ResultadoDeteccionSilencios(silencios=[(1.0, 2.0)], duracion=10.0)


def _fake_transcribir(cortado, ajustes_transc, audio, *, runner, **_kw) -> List[Any]:
    return []


def _drive(orden_clips: Sequence[str], *, silencios_activado: bool) -> tuple:
    eventos: List[EventoProgreso] = []
    resultado_box: dict = {}

    def _run() -> None:
        tmp = Path(tempfile.mkdtemp(prefix="preserv-diag-"))
        prev_wk, prev_out = config.WORKDIR_ROOT, config.OUTPUT_ROOT
        config.WORKDIR_ROOT = tmp / "wk"
        config.OUTPUT_ROOT = tmp / "out"
        try:
            job = JobWorkdir("preservacion")
            ajustes = Ajustes()
            ajustes.silencios.activado = silencios_activado
            resultado_box["r"] = ejecutar_pipeline(
                job,
                list(orden_clips),
                ajustes,
                reporter=eventos.append,
                fn_unir=_fake_unir,
                fn_detectar=_fake_detectar,
                fn_transcribir=_fake_transcribir,
            )
        finally:
            config.WORKDIR_ROOT = prev_wk
            config.OUTPUT_ROOT = prev_out

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        pool.submit(_run).result(timeout=_WALL_CLOCK_CAP_S)
    return resultado_box["r"], eventos


# ===========================================================================
# Monotonic percentage; state/substep independent of percentage (Req 3.8)
# ===========================================================================
def test_porcentaje_monotono_y_estado_independiente_del_porcentaje() -> None:
    """Progress percentage is monotonic non-decreasing, and multiple distinct
    substeps share the value 25 (state/substep change while the percentage does
    not) — the exact behavior the diagnostics must preserve."""
    _resultado, eventos = _drive(["/clips/a.mp4", "/clips/b.mp4"], silencios_activado=True)

    porcentajes = [e.porcentaje for e in eventos]
    assert porcentajes, "the drive produced no progress events"
    # Monotonic non-decreasing.
    for anterior, siguiente in zip(porcentajes, porcentajes[1:]):
        assert siguiente >= anterior, f"percentage regressed: {porcentajes}"

    # Several distinct substeps share percentage 25 → percentage is not the state.
    en_25 = [e for e in eventos if e.porcentaje == 25]
    assert len(en_25) >= 3, f"expected multiple substeps at 25%%: {porcentajes}"
    mensajes_25 = {e.mensaje for e in en_25}
    assert len(mensajes_25) >= 2, (
        "the message/substep must change while the percentage stays at 25"
    )


# ===========================================================================
# Pause semantics with silences enabled vs disabled (Req 3.6, 3.7)
# ===========================================================================
def test_pausa_con_silencios_activados_preserva_unido_y_no_transcribe() -> None:
    """With silences enabled the pipeline pauses at ``ESPERANDO_EDICION_SILENCIOS``,
    preserving the joined video and detected segments, and does NOT start
    transcription before the pause."""
    resultado, eventos = _drive(["/clips/a.mp4", "/clips/b.mp4"], silencios_activado=True)

    assert resultado.pendiente_edicion_silencios is True
    assert resultado.exito is False
    assert resultado.unido is not None            # joined video preserved
    assert resultado.silencios == [(1.0, 2.0)]    # detected segments preserved
    assert resultado.duracion_unido_s == 10.0
    # Transcription (step 3) never started before the pause.
    assert not any(e.paso_actual == PipelineStep.TRANSCRIBIR for e in eventos)
    # No terminal failure.
    assert not any(e.estado == JobStatus.FALLIDO for e in eventos)


def test_sin_silencios_no_hay_pausa_de_edicion() -> None:
    """With silences disabled there is no silence-edit pause; the pipeline
    proceeds past the 25 % boundary toward transcription (Req 3.7)."""
    resultado, eventos = _drive(["/clips/a.mp4"], silencios_activado=False)

    assert resultado.pendiente_edicion_silencios is False
    # It advanced to preparing subtitles (paused later for render choice), i.e.
    # it did NOT stop at the silence-edit pause.
    assert resultado.pendiente_eleccion_render is True
    assert any(e.paso_actual == PipelineStep.TRANSCRIBIR for e in eventos)
