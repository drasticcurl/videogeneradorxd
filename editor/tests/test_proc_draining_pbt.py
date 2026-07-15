"""Property 3 (Preservation): no-deadlock concurrent output draining.

Bugfix spec: ``unir-step-hang``. Observation-first characterization test. It
pins the CURRENT behavior of the external-tool funnel
``app.engine.proc.ejecutar_comando``: regardless of how much data a tool writes
to ``stdout`` and/or ``stderr`` — including volumes far exceeding the ~64 KB OS
pipe buffer — the executor drains both streams concurrently, so the child can
never block on ``write()`` while the parent blocks on ``read()``.

This is the invariant the ``Popen`` migration (Task 6.2) MUST preserve: a naive
``Popen`` with sequential single-stream reads would deadlock here. This module
deliberately does NOT import ``ComandoTimeoutError`` so it runs (and PASSES) on
the UNFIXED code as a baseline, and continues to pass after the fix (Task 6.8).

EXPECTED OUTCOME on UNFIXED code: PASS (no current deadlock).

Validates: Requirements 2.4
"""

from __future__ import annotations

import os
import sys
import threading
import time
from typing import Callable, Tuple

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from app.engine.proc import ejecutar_comando

pytestmark = pytest.mark.skipif(
    os.name != "posix", reason="real-subprocess draining tests are POSIX-only"
)

_GRACE_S = 10.0


def _run_guarded(fn: Callable[[], object], cap_s: float) -> Tuple[str, object]:
    """Run ``fn`` bounded by ``cap_s`` wall-clock seconds (see Property 1 module)."""
    box: dict = {}

    def target() -> None:
        try:
            box["result"] = fn()
        except BaseException as exc:  # noqa: BLE001
            box["error"] = exc

    t = threading.Thread(target=target, daemon=True)
    t.start()
    t.join(cap_s)
    if t.is_alive():
        return ("HANG", None)
    if "error" in box:
        return ("RAISED", box["error"])
    return ("RETURNED", box.get("result"))


# Sizes span below, at, and well beyond the ~64 KB OS pipe buffer.
_SIZES = st.sampled_from([0, 1024, 64 * 1024, 200 * 1024, 512 * 1024])
_STREAMS = st.sampled_from(["stdout", "stderr", "both"])


@settings(
    max_examples=12,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow, HealthCheck.function_scoped_fixture],
)
@given(nbytes=_SIZES, stream=_STREAMS)
def test_p3_large_output_does_not_deadlock(nbytes: int, stream: str) -> None:
    """Large stdout/stderr is fully captured without deadlock (Req 2.4)."""
    # Child writes exactly ``nbytes`` ASCII chars to the chosen stream(s), exits 0.
    code = (
        "import sys\n"
        f"n = {nbytes}\n"
        f"stream = {stream!r}\n"
        "payload = 'x' * n\n"
        "if stream in ('stdout', 'both'):\n"
        "    sys.stdout.write(payload); sys.stdout.flush()\n"
        "if stream in ('stderr', 'both'):\n"
        "    sys.stderr.write(payload); sys.stderr.flush()\n"
        "sys.exit(0)\n"
    )
    child = [sys.executable, "-c", code]

    kind, payload = _run_guarded(lambda: ejecutar_comando(child), _GRACE_S)
    assert kind == "RETURNED", f"executor must not deadlock; got {kind} ({payload!r})"

    assert payload.returncode == 0
    expected_out = nbytes if stream in ("stdout", "both") else 0
    expected_err = nbytes if stream in ("stderr", "both") else 0
    assert len(payload.stdout) == expected_out, "stdout not fully captured"
    assert len(payload.stderr) == expected_err, "stderr not fully captured"
