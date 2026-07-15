"""Property 1 (Bug Condition): bounded, non-hanging termination of external-tool steps.

Bugfix spec: ``unir-step-hang``. This module is written BEFORE the fix
(bug-condition methodology). It encodes the *expected post-fix* contract for the
single external-tool subprocess funnel ``app.engine.proc.ejecutar_comando``:

    For any external-tool invocation bounded by a ``timeout`` that would block or
    exceed its deadline, the executor MUST terminate within ``timeout + grace``,
    raising ``ComandoTimeoutError`` (an ``OSError`` subclass) with an actionable
    message, and MUST terminate the *whole process group* so no orphaned
    grandchild survives.

Every test that spawns a real child is wrapped in a hard wall-clock guard
(``_run_guarded``) so the suite itself can NEVER hang while reproducing the bug.

Observed counterexamples on the UNFIXED code (documented per methodology; see
design "Hypothesized Root Cause" and "Exploratory Bug Condition Checking"):

* **1a Unbounded wait (headline):** ``ejecutar_comando(sleeper)`` invoked WITHOUT
  a timeout (exactly how every call site invokes the runner today) does NOT
  return within a generous wall-clock guard — it hangs indefinitely, reproducing
  the "stuck at 25 %, zero output" symptom. Guarded run: ``('HANG', 4.0s)``.
* **Wrong error type on bounded timeout:** ``ejecutar_comando(sleeper, timeout=1)``
  raises the raw ``subprocess.TimeoutExpired`` (not the actionable
  ``ComandoTimeoutError`` that the pipeline maps to ``FALLIDO {paso, motivo}``),
  and — critically — kills only the *direct* child, so a grandchild survives.
* **Type absent:** ``app.engine.proc.ComandoTimeoutError`` does not exist yet, so
  this module fails to import on the unfixed code (expected: proves the bug).

EXPECTED OUTCOME on UNFIXED code: FAIL (import of ``ComandoTimeoutError`` fails /
the actionable-error contract is unmet). DO NOT fix ``proc.py`` to make this pass
here — the fix lands in Task 6 and this same test verifies it in Task 6.7.

Validates: Requirements 1.1, 1.2, 1.5, 2.1, 2.2, 2.3, 2.6
"""

from __future__ import annotations

import os
import sys
import threading
import time
from typing import Callable, Optional, Tuple

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from app.engine.proc import ComandoTimeoutError, ejecutar_comando

# Session/process-group semantics (start_new_session + os.killpg) are POSIX.
# Standalone/local Windows runs are unaffected by the fix (Req 3.3), so skip the
# real-subprocess tests there.
pytestmark = pytest.mark.skipif(
    os.name != "posix", reason="real-subprocess timeout/process-group tests are POSIX-only"
)

# Hard wall-clock ceiling for any guarded call so the suite can never hang.
_GRACE_S = 5.0


def _run_guarded(fn: Callable[[], object], cap_s: float) -> Tuple[str, float, object]:
    """Run ``fn`` in a daemon thread bounded by ``cap_s`` wall-clock seconds.

    Returns ``(kind, elapsed, payload)`` where ``kind`` is:
      * ``"HANG"``   — did not finish within the cap (payload ``None``);
      * ``"RAISED"`` — raised (payload is the exception instance);
      * ``"RETURNED"`` — returned normally (payload is the return value).

    The guard guarantees the *test harness* returns even if the child hangs; a
    lingering daemon thread cannot block pytest from completing.
    """
    box: dict = {}

    def target() -> None:
        try:
            box["result"] = fn()
        except BaseException as exc:  # noqa: BLE001 - we inspect it in the test
            box["error"] = exc

    t = threading.Thread(target=target, daemon=True)
    start = time.monotonic()
    t.start()
    t.join(cap_s)
    elapsed = time.monotonic() - start
    if t.is_alive():
        return ("HANG", elapsed, None)
    if "error" in box:
        return ("RAISED", elapsed, box["error"])
    return ("RETURNED", elapsed, box.get("result"))


def _py(code: str) -> list:
    """Build an argv that runs a tiny inline Python child via ``sys.executable``."""
    return [sys.executable, "-c", code]


def _assert_actionable(exc: ComandoTimeoutError, timeout: float) -> None:
    """The timeout error message must be actionable (Req 2.3)."""
    msg = str(exc)
    assert isinstance(exc, OSError), "ComandoTimeoutError must derive from OSError"
    # Command name (python executable basename) and the timeout value appear.
    assert os.path.basename(sys.executable) in msg or "python" in msg.lower()
    assert str(int(timeout)) in msg or repr(timeout) in msg or f"{timeout}" in msg


# ---------------------------------------------------------------------------
# 1a — Unbounded wait (headline). A child that sleeps far longer than the
# bounded deadline must be cut promptly with an actionable ComandoTimeoutError.
# Scoped Hypothesis property: small (sleep, timeout) variants, each guarded.
# ---------------------------------------------------------------------------
@settings(
    max_examples=8,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow, HealthCheck.function_scoped_fixture],
)
@given(
    sleep_s=st.sampled_from([10, 30, 120]),
    timeout_s=st.sampled_from([1.0, 2.0]),
)
def test_1a_unbounded_wait_is_bounded_by_timeout(sleep_s: int, timeout_s: float) -> None:
    """A far-too-long child is terminated within ``timeout + grace`` (Req 2.1, 2.2)."""
    child = _py(f"import time; time.sleep({sleep_s})")
    kind, elapsed, payload = _run_guarded(
        lambda: ejecutar_comando(child, timeout=timeout_s), timeout_s + _GRACE_S
    )
    assert kind == "RAISED", f"expected prompt ComandoTimeoutError, got {kind} ({payload!r})"
    assert isinstance(payload, ComandoTimeoutError), f"got {payload!r}"
    assert elapsed <= timeout_s + _GRACE_S
    _assert_actionable(payload, timeout_s)


# ---------------------------------------------------------------------------
# 1b — Blocked on inherited stdin. With stdin redirected from the null device,
# a child that reads stdin to EOF returns immediately (never hangs waiting for
# input). This pins the primary *prevention* (stdin=DEVNULL), not just the cut.
# ---------------------------------------------------------------------------
def test_1b_stdin_from_devnull_does_not_block() -> None:
    """A child reading stdin gets immediate EOF (stdin=DEVNULL) and exits 0."""
    child = _py("import sys; data = sys.stdin.read(); sys.exit(0 if data == '' else 3)")
    kind, elapsed, payload = _run_guarded(
        lambda: ejecutar_comando(child, timeout=5.0), 5.0 + _GRACE_S
    )
    assert kind == "RETURNED", f"stdin reader must not hang; got {kind} ({payload!r})"
    assert getattr(payload, "returncode", None) == 0, f"expected clean EOF exit, got {payload!r}"


# ---------------------------------------------------------------------------
# 1c — Grandchild survival. On timeout the WHOLE process group must be killed,
# so a long-lived grandchild spawned by the child does not survive (motivates
# start_new_session=True + os.killpg). The grandchild writes its PID to a file;
# after the timeout, that PID must be dead.
# ---------------------------------------------------------------------------
def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def test_1c_timeout_kills_whole_process_group(tmp_path) -> None:
    """Timeout terminates the process group; no orphaned grandchild survives (Req 2.6)."""
    pid_file = tmp_path / "grandchild.pid"
    # Grandparent spawns a grandchild (long sleep), records its PID, then blocks.
    code = (
        "import subprocess, sys, time;"
        "gc = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)']);"
        f"open({str(pid_file)!r}, 'w').write(str(gc.pid));"
        "time.sleep(120)"
    )
    child = _py(code)
    kind, _elapsed, payload = _run_guarded(
        lambda: ejecutar_comando(child, timeout=2.0), 2.0 + _GRACE_S
    )
    assert kind == "RAISED" and isinstance(payload, ComandoTimeoutError), (
        f"expected ComandoTimeoutError, got {kind} ({payload!r})"
    )

    # Wait briefly for the group kill to propagate to the grandchild.
    grandchild_pid: Optional[int] = None
    for _ in range(50):
        if pid_file.exists():
            try:
                grandchild_pid = int(pid_file.read_text().strip())
                break
            except ValueError:
                pass
        time.sleep(0.05)
    assert grandchild_pid is not None, "grandchild never recorded its PID"

    deadline = time.monotonic() + _GRACE_S
    while _pid_alive(grandchild_pid) and time.monotonic() < deadline:
        time.sleep(0.05)
    if _pid_alive(grandchild_pid):
        # Clean up so we never leak a real process, then fail the assertion.
        try:
            os.kill(grandchild_pid, 9)
        except OSError:
            pass
        pytest.fail(f"orphaned grandchild {grandchild_pid} survived process-group kill")
