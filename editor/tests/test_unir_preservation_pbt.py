"""Properties 2, 4 & 5 (Preservation) for the ``unir-step-hang`` bugfix.

Observation-first preservation baselines. These target the CURRENT public
behavior of the UNIR-step call sites (``normalize.unir_clips``,
``ffprobe.inspeccionar_clip``) through injected ``Runner`` doubles — never real
binaries — so the fix (routing calls through ``invocar_runner`` with a bounded
timeout) cannot change observable behavior for non-buggy inputs.

Deliberately does NOT import any not-yet-existing symbol (e.g.
``ComandoTimeoutError``/``invocar_runner``), so this module runs and PASSES on
the UNFIXED code, and continues to pass after the fix (Tasks 6.9, 6.10).

* **Property 2 — Identical behavior for non-buggy inputs** (Task 3):
  - 3a success equivalence: a double returning ``returncode=0`` drives
    ``unir_clips`` (hard-cut path) to the same ``unido.mp4`` path, the same
    ``concat.txt`` contents, and the same per-clip normalization commands.
  - 3b non-zero exit equivalence: a double returning non-zero raises the same
    step-specific error (``NormalizacionError`` / ``ClipInspeccionError``) with
    the responsible ``ruta``/``motivo`` and no partial ``unido.mp4`` referenced.
* **Property 4 — Order preservation** (Task 4): the exact ``Orden_de_Clips`` is
  preserved in ``concat.txt`` and in the per-clip normalization order.
* **Property 5 — Backward-compatible runner injection** (Task 5): both
  single-arg (``args``) and timeout-aware (``args, timeout=None``) doubles are
  invoked with the same command args and return the same ``ResultadoComando``,
  with no ``TypeError``.

Observed unfixed behavior (recorded before asserting): with a success double,
``unir_clips`` returns ``<workdir>/unido.mp4`` and writes ``concat.txt`` listing
``norm_000.mp4 .. norm_{n-1}.mp4`` (absolute workdir paths) in input order; a
non-zero double raises ``NormalizacionError(ruta=<clip0>, "normalización falló: ...")``.

EXPECTED OUTCOME on UNFIXED code: PASS.

Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import List, Optional, Sequence

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from app import config
from app.engine.ffprobe import (
    ClipInfo,
    ClipInspeccionError,
    construir_comando_ffprobe,
    inspeccionar_clip,
)
from app.engine.normalize import (
    NOMBRE_CONCAT_TXT,
    NOMBRE_UNIDO,
    NormalizacionError,
    contenido_concat_txt,
    parsear_concat_txt,
    unir_clips,
)
from app.engine.proc import ResultadoComando
from app.storage.workdir import JobWorkdir

_PBT = settings(
    max_examples=60,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture, HealthCheck.too_slow],
)


@pytest.fixture(autouse=True)
def _isolate_workdir(monkeypatch, tmp_path):
    """Redirect the workdir/output roots into a temp dir for every example."""
    monkeypatch.setattr(config, "WORKDIR_ROOT", tmp_path / "wk")
    monkeypatch.setattr(config, "OUTPUT_ROOT", tmp_path / "out")


def _nuevo_job() -> JobWorkdir:
    return JobWorkdir("job-" + uuid.uuid4().hex[:12])


# ---------------------------------------------------------------------------
# Injected runner doubles (record the exact command args they receive)
# ---------------------------------------------------------------------------
class _Recorder:
    """Records the exact command args each injected runner call receives."""

    def __init__(self, returncode: int = 0, stdout: str = "", stderr: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        self.calls: List[List[str]] = []

    def resultado(self, args: Sequence[str]) -> ResultadoComando:
        self.calls.append(list(args))
        return ResultadoComando(
            returncode=self.returncode, stdout=self.stdout, stderr=self.stderr,
            args=list(args),
        )


def _make_runner(rec: "_Recorder", shape: str):
    """Build a genuine ``Runner`` double with the requested call signature.

    * ``"single"`` — ``runner(args)`` (no ``timeout`` parameter at all), the
      shape of legacy doubles like ``def _cmd_ok(args): ...``.
    * ``"timeout"`` — ``runner(args, timeout=None)``, a timeout-aware double.

    The signature is real (not emulated), so ``inspect.signature``-based dispatch
    in ``invocar_runner`` sees exactly what a real double of each shape exposes.
    """
    if shape == "single":
        def runner(args):  # type: ignore[no-untyped-def]
            return rec.resultado(args)
        return runner

    def runner(args, timeout=None):  # type: ignore[no-untyped-def]
        return rec.resultado(args)
    return runner


# Backwards-friendly alias used across the tests below.
def _RunnerDoble(returncode: int = 0, stdout: str = "", stderr: str = "",
                 shape: str = "single"):
    """Return ``(recorder, runner)`` combined into one object for convenience."""
    rec = _Recorder(returncode=returncode, stdout=stdout, stderr=stderr)
    runner = _make_runner(rec, shape)
    # Expose the recorder's call log on the runner for assertions.
    runner.calls = rec.calls  # type: ignore[attr-defined]
    return runner


def _ffprobe_json(ancho: int = 1080, alto: int = 1920, fps: str = "30/1",
                  audio: bool = True, dur: str = "8.0") -> str:
    streams = [{"codec_type": "video", "width": ancho, "height": alto, "avg_frame_rate": fps}]
    if audio:
        streams.append({"codec_type": "audio"})
    return json.dumps({"streams": streams, "format": {"duration": dur}})


def _clipinfo(ruta: str, audio: bool = True) -> ClipInfo:
    return ClipInfo(
        ruta=ruta, ancho=1080, alto=1920, rotacion=0, fps=30.0,
        duracion_s=8.0, tiene_video=True, tiene_audio=audio,
    )


# Clip-path strategy: non-empty, no newlines/quotes (kept simple; order-only).
def _rutas() -> st.SearchStrategy[List[str]]:
    ref = st.text(
        alphabet=st.characters(min_codepoint=97, max_codepoint=122),
        min_size=1, max_size=8,
    ).map(lambda s: f"/clips/{s}.mp4")
    return st.lists(ref, min_size=1, max_size=6)


# ===========================================================================
# Property 2 — 3a: success equivalence (Req 3.1, 3.3)
# ===========================================================================
@_PBT
@given(rutas=_rutas(), tiene_audio=st.booleans())
def test_p2_3a_exito_equivalente(rutas: List[str], tiene_audio: bool) -> None:
    """A success double yields the same unido path, concat.txt and clip order."""
    job = _nuevo_job()
    doble = _RunnerDoble(returncode=0, shape="single")

    def inspector(ruta: str) -> ClipInfo:
        return _clipinfo(ruta, audio=tiene_audio)

    salida = unir_clips(job, rutas, 1080, 1920, 30, runner=doble, inspector=inspector)

    # Returned path is exactly <workdir>/unido.mp4.
    assert salida == job.resolve(NOMBRE_UNIDO)

    # concat.txt was written listing the intermediates in input order.
    concat_path = job.resolve(NOMBRE_CONCAT_TXT)
    assert concat_path.is_file()
    intermedios_esperados = [str(job.resolve("norm_%03d.mp4" % i)) for i in range(len(rutas))]
    assert parsear_concat_txt(concat_path.read_text(encoding="utf-8")) == intermedios_esperados
    assert concat_path.read_text(encoding="utf-8") == contenido_concat_txt(intermedios_esperados)

    # One normalize command per clip (in order) + one concat command.
    normalize_calls = [c for c in doble.calls if "-map" in c]
    assert len(normalize_calls) == len(rutas)
    # The concat command references concat.txt and produces unido.mp4.
    concat_calls = [c for c in doble.calls if "concat" in c and str(concat_path) in c]
    assert len(concat_calls) == 1
    assert str(salida) in concat_calls[0]


# ===========================================================================
# Property 2 — 3b: non-zero exit equivalence (Req 3.2, 3.6)
# ===========================================================================
@_PBT
@given(rutas=_rutas())
def test_p2_3b_normalizacion_fallida(rutas: List[str]) -> None:
    """A non-zero double makes unir_clips raise NormalizacionError for clip 0."""
    job = _nuevo_job()
    doble = _RunnerDoble(returncode=1, stderr="boom", shape="single")

    with pytest.raises(NormalizacionError) as exc_info:
        unir_clips(job, rutas, 1080, 1920, 30, runner=doble,
                   inspector=lambda r: _clipinfo(r))

    err = exc_info.value
    assert err.ruta == rutas[0]
    assert "normalización falló" in err.motivo
    # No unido.mp4 is produced/referenced as success.
    assert not job.resolve(NOMBRE_UNIDO).exists()


@_PBT
@given(nombre=st.text(alphabet="abcdefghijklmnop", min_size=1, max_size=8))
def test_p2_3b_inspeccion_fallida(nombre: str) -> None:
    """A non-zero ffprobe double makes inspeccionar_clip raise ClipInspeccionError."""
    ruta = f"/clips/{nombre}.mp4"
    doble = _RunnerDoble(returncode=1, stderr="corrupto", shape="single")
    with pytest.raises(ClipInspeccionError) as exc_info:
        inspeccionar_clip(ruta, runner=doble)
    assert exc_info.value.ruta == ruta
    assert "ffprobe falló" in exc_info.value.motivo


# ===========================================================================
# Property 4 — order preservation (Req 3.4, 3.6)
# ===========================================================================
@_PBT
@given(rutas=_rutas())
def test_p4_orden_preservado(rutas: List[str]) -> None:
    """concat.txt round-trip preserves order, and per-clip normalization follows
    the exact user order."""
    # Pure round-trip on the intermediates.
    intermedios = [f"norm_{i:03d}.mp4" for i in range(len(rutas))]
    assert parsear_concat_txt(contenido_concat_txt(intermedios)) == intermedios

    # Full unir_clips run: the normalize commands consume the clips in input order.
    job = _nuevo_job()
    doble = _RunnerDoble(returncode=0, shape="single")
    unir_clips(job, rutas, 1080, 1920, 30, runner=doble,
               inspector=lambda r: _clipinfo(r))

    normalize_calls = [c for c in doble.calls if "-map" in c]
    # Each normalize command contains its source clip as the input (-i <clip>).
    entradas: List[str] = []
    for cmd in normalize_calls:
        # The source clip is the argument immediately following the LAST "-i".
        idx = len(cmd) - 1 - cmd[::-1].index("-i")
        entradas.append(cmd[idx + 1])
    assert entradas == list(rutas)


# ===========================================================================
# Property 5 — backward-compatible runner injection (Req 3.4, 3.5)
# ===========================================================================
@_PBT
@given(nombre=st.text(alphabet="abcdefghijklmnop", min_size=1, max_size=8),
       shape=st.sampled_from(["single", "timeout"]))
def test_p5_inyeccion_inspeccionar(nombre: str, shape: str) -> None:
    """inspeccionar_clip works with both single-arg and timeout-aware doubles."""
    ruta = f"/clips/{nombre}.mp4"
    doble = _RunnerDoble(returncode=0, stdout=_ffprobe_json(), shape=shape)
    info = inspeccionar_clip(ruta, runner=doble)
    assert isinstance(info, ClipInfo)
    assert info.ruta == ruta
    # The double was invoked with exactly the ffprobe command.
    assert doble.calls == [construir_comando_ffprobe(ruta)]


@_PBT
@given(rutas=_rutas(), shape=st.sampled_from(["single", "timeout"]))
def test_p5_inyeccion_unir_clips(rutas: List[str], shape: str) -> None:
    """unir_clips works with both single-arg and timeout-aware doubles."""
    job = _nuevo_job()
    doble = _RunnerDoble(returncode=0, shape=shape)
    salida = unir_clips(job, rutas, 1080, 1920, 30, runner=doble,
                        inspector=lambda r: _clipinfo(r))
    assert salida == job.resolve(NOMBRE_UNIDO)
    # No TypeError, and the double received one normalize call per clip.
    assert len([c for c in doble.calls if "-map" in c]) == len(rutas)
