# UNIR Step Hang Bugfix Design

## Overview

A valid edit job (2 clips of ~8 s each) reaches the **UNIR** step (Paso 1) and freezes at 25 % forever in the combined Cloud Run container (`EDIT_MODE=cloud`, `VSE_STORAGE_BACKEND=volume`). The job neither completes nor fails; the only log activity is the progress-polling loop. This design fixes the **true root-cause mechanism of the indefinite block** in the subprocess executor and adds a bounded timeout **only as a secondary, defense-in-depth safety net**.

The single funnel for every external tool invocation (`ffmpeg`, `ffprobe`, `auto-editor`, Remotion/node) is `app/engine/proc.py::ejecutar_comando`, wired through an injectable `Runner`. The fix reworks that executor so that a blocking child can **never** cause an unbounded, silent wait, regardless of tool verbosity or environment, while preserving every existing behavior, injected test double, and property-based guarantee.

**Design strategy (in priority order):**

1. **Structural (root cause):** make the executor unable to block indefinitely for any healthy tool run — drain `stdout`/`stderr` concurrently (no pipe-buffer coupling), redirect `stdin` from the null device (no tool blocks waiting for input), and run the child in its own process group so it — and every grandchild it spawns — can be terminated as a unit.
2. **Defense-in-depth (safety net):** enforce a uniform, bounded timeout through the `Runner` contract. On expiry, kill the whole process group, drain whatever output remains, and raise an actionable error. The timeout only *cuts* a hang that should never happen for valid small inputs; the structural fixes are what *prevent* the hang.
3. **Observability & failure propagation:** surface UNIR sub-steps in logs, and route timeouts/failures to the job's `FALLIDO` state with `{paso, motivo}` for the generator UI.

### Important root-cause honesty note

The current `ejecutar_comando` calls `subprocess.run(..., stdout=PIPE, stderr=PIPE, text=True, timeout=None)`. `subprocess.run` internally uses `Popen.communicate()`, which **already drains both pipes concurrently** (selector-based on POSIX, threads on Windows). Therefore a *classic pipe-buffer deadlock is not possible in the code as it exists today*. The confirmed defect that produces the observed "stuck at 25 %, zero output" symptom is the **unbounded wait** (`timeout=None`) on a child that blocks (e.g. a stalled GCS-FUSE-backed read, or a tool blocked on inherited `stdin`), compounded by the fact that `subprocess.run`'s own `timeout` — even if we simply set it — kills **only the direct child**, leaving grandchild processes (e.g. `ffmpeg` spawned by `auto-editor`, or helper processes) able to hold the pipes open so `communicate()` can still block.

The no-deadlock concurrent-draining guarantee is therefore treated as a **required invariant** the fix must **preserve** — because the fix moves to a `Popen`-based executor (required to kill the *process group* on timeout), and a naive `Popen` with sequential `read()` calls *would* introduce exactly the deadlock the requirements warn against. The design mandates concurrent draining precisely so the migration to `Popen` cannot regress into a real pipe-buffer deadlock.

## Glossary

- **Bug_Condition (C)**: A pipeline step invokes an external tool through a `Runner` whose subprocess execution does not enforce a bounded execution deadline and/or can block on I/O — so a slow/blocking tool causes an unbounded, silent wait. Formally, `X.invokesExternalTool AND NOT X.enforcesBoundedTimeout`.
- **Property (P)**: For any input satisfying C, the fixed executor terminates within a bounded time — succeeding, or failing with an actionable `{paso, motivo}` — and never hangs.
- **Preservation**: For any input **not** satisfying C (tools that return within their deadline, standalone/local runs, injected single-arg runner doubles), the fixed code produces the same observable result as the original.
- **F**: The original executor/pipeline (`subprocess.run(..., timeout=None)`, `Runner` with no timeout in its contract).
- **F'**: The fixed executor/pipeline (`Popen`-based, `stdin` from null device, concurrent draining, bounded timeout, process-group kill).
- **`ejecutar_comando`**: The default `Runner` in `app/engine/proc.py`; the single subprocess funnel for all external tools.
- **`Runner`**: `Callable[..., ResultadoComando]`, the injectable command-executor contract. Call sites currently invoke it as `runner(comando)`.
- **Runner double**: A test-provided `Runner` (e.g. `__call__(self, args)` or `_cmd_ok(args, timeout=None)`) used to simulate tool success/failure without the real binaries.
- **Process group / session**: On POSIX, a child started with `start_new_session=True` becomes a session/process-group leader; `os.killpg(os.getpgid(pid), sig)` terminates the child **and all its descendants** as a unit.
- **Pipe-buffer deadlock**: When a child writes more than the ~64 KB OS pipe buffer to a stream the parent is not concurrently reading, the child blocks on `write()` and the parent blocks on `read()` → permanent hang. Avoided by concurrent draining of both streams.
- **UNIR (Paso 1)**: Normalize each clip to 9:16 and concatenate (`app/engine/normalize.py::unir_clips`), preceded by per-clip `ffprobe` inspection.

## Bug Details

### Bug Condition

The bug manifests whenever a pipeline step invokes an external tool through the `Runner` and the underlying subprocess execution cannot be bounded: `ejecutar_comando` passes `timeout=None`, its `Runner` type signature carries no `timeout` parameter, and every call site invokes `runner(comando)` with no deadline. When the child blocks (a stalled FUSE read on the volume backend, a tool waiting on inherited `stdin`, or any tool that fails to make progress), the executor waits forever. Because the pipeline runs in a background executor thread (`loop.run_in_executor`), the step freezes with no progress update and no failure — exactly the "stuck at 25 %, zero output" symptom.

**Formal Specification:**
```
FUNCTION isBugCondition(X)
  INPUT: X of type PipelineStepExecution
  OUTPUT: boolean

  RETURN X.invokesExternalTool
     AND NOT X.enforcesBoundedTimeout
END FUNCTION
```

### Examples

- **Counterexample (headline):** Job with 2 valid ~8 s clips in cloud mode; the UNIR-step `ffprobe`/`ffmpeg` read blocks on the GCS-FUSE-backed input. Expected: UNIR completes in seconds (or fails with an actionable motive). Actual: job stuck at 25 % forever, zero tool output.
- **Large-stderr stress (invariant we must not regress):** a tool emits > 64 KB to `stderr` while the parent is not concurrently draining it. Expected: parent keeps reading, tool finishes normally. Actual under a naive `Popen`-with-sequential-reads implementation: pipe-buffer deadlock. (The current `subprocess.run` avoids this; F' must too.)
- **Blocked on stdin:** a tool reads from an inherited `stdin` that never yields EOF. Expected: tool never blocks on input (stdin is the null device). Actual (before fix): potential indefinite wait.
- **Slow-but-healthy tool (edge case):** a legitimately long transcription that finishes just under its deadline. Expected: completes successfully; the timeout does not fire.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Successful tool runs that complete within their deadline return the identical `ResultadoComando` (same `returncode`, `stdout`, `stderr`, `args`) and the pipeline produces the same correct 9:16 output and step progression.
- Non-zero exit codes continue to raise the existing step-specific errors (`NormalizacionError`, `ClipInspeccionError`, `SilenceProcessingError`, …) with the responsible clip and motive, and no partial output is referenced as success.
- Standalone/local mode (`EDIT_MODE=local`, `VSE_STORAGE_BACKEND=local`) behaves exactly as today for valid inputs.
- The exact `Orden_de_Clips` is preserved in concatenation (no reorder/omit/duplicate).
- Injected `Runner` doubles — including **single-argument** doubles `__call__(self, args)` — keep working without accepting a `timeout` parameter.
- All existing pytest + Hypothesis guarantees (pure normalization math, order preservation, homogenization, command construction, injectable-runner behavior, signal-code interpretation) continue to hold.

**Scope:**
All inputs that do NOT satisfy the bug condition must be completely unaffected by this fix. This includes:
- Tool invocations that return (success or non-zero) within their deadline.
- Any run using an injected `Runner` double (these never spawn real subprocesses, so timeout/draining/process-group logic is bypassed).
- Pure/deterministic helpers (`plan_normalizacion`, `contenido_concat_txt`, `calcular_segmentos_conservar`, `parsear_silencedetect`, …) which perform no subprocess I/O.

The actual expected correct behavior for buggy inputs is defined in the Correctness Properties section below.

## Hypothesized Root Cause

Based on the bug analysis and direct inspection of `proc.py` and every call site, ranked from most to least likely:

1. **Unbounded wait (confirmed, primary).** `ejecutar_comando` uses `subprocess.run(..., timeout=None)`. If the child blocks — a stalled read on the GCS-FUSE-backed volume being the most likely cloud trigger — `communicate()` waits forever. The `Runner` type (`Callable[[Sequence[str]], ResultadoComando]`) does not even carry a `timeout`, and no call site passes one, so there is no deadline anywhere in the funnel.

2. **Direct-child-only termination (confirmed, why "just add a timeout" is insufficient).** Even if `subprocess.run(timeout=X)` were used, on expiry it kills only the immediate child and then re-enters draining; grandchildren (e.g. `ffmpeg` launched by `auto-editor`, or worker/helper processes) can keep the pipe write-ends open, so the parent can still block. Bounded termination requires killing the **whole process group**, which requires `Popen` + `start_new_session=True` + `os.killpg`.

3. **Inherited `stdin` (contributing).** Neither `stdout`/`stderr` capture nor `subprocess.run` redirects `stdin`; the child inherits the parent's. A tool that reads `stdin` (ffmpeg reads it for interactive control; some tools block waiting for input) can stall. Redirecting `stdin` from the null device removes this class of hang.

4. **Pipe-buffer deadlock (NOT the current mechanism, but a regression risk to guard against).** `subprocess.run`/`communicate()` already drains both pipes concurrently, so the current code cannot deadlock on a full pipe. However, the fix migrates to `Popen` to obtain process-group control; if that migration used sequential single-stream reads it would introduce the deadlock. The design mandates concurrent draining to prevent this.

## Correctness Properties

Property 1: Bug Condition — Bounded, Non-Hanging Termination of External-Tool Steps

_For any_ step execution where the bug condition holds (`isBugCondition` returns true: an external tool that would block or exceed its deadline), the fixed executor SHALL terminate within a bounded time — either returning a `ResultadoComando`, or raising an actionable error that the pipeline maps to the `FALLIDO` state with `{paso, motivo}` — and SHALL NOT wait indefinitely. On timeout it SHALL terminate the entire process group and SHALL NOT reference any partial artifact as a successful result.

**Validates: Requirements 2.1, 2.2, 2.3, 2.6**

Property 2: Preservation — Identical Behavior for Non-Buggy Inputs

_For any_ input where the bug condition does NOT hold (tools that return within their deadline, standalone/local runs, injected runner doubles), the fixed code SHALL produce the same observable result as the original function — the same `ResultadoComando` on success, the same step-specific error on non-zero exit, the same produced artifacts and pipeline progression — preserving all current behavior.

**Validates: Requirements 3.1, 3.2, 3.3**

Property 3: No-Deadlock Concurrent Output Draining

_For any_ subprocess execution — regardless of how much data the tool writes to `stdout` and/or `stderr` (including volumes far exceeding the OS pipe buffer) — the fixed executor SHALL drain both streams concurrently so the child can never block on `write()` while the parent blocks on `read()`. A tool emitting arbitrarily large `stderr` SHALL still be allowed to run to completion without deadlock, and its full output SHALL be captured.

**Validates: Requirements 2.4**

Property 4: Order Preservation (Unchanged)

_For any_ user-provided `Orden_de_Clips`, the fixed pipeline SHALL preserve the exact clip order in concatenation, without reordering, omitting, or duplicating clips — identical to the original behavior.

**Validates: Requirements 3.6**

Property 5: Backward-Compatible Runner Injection

_For any_ injected `Runner` double — including single-argument doubles with signature `__call__(self, args)` that do not accept a `timeout` parameter — the fixed call sites SHALL invoke it successfully with the same arguments and obtain the same `ResultadoComando` as before, without raising `TypeError`. Timeout enforcement SHALL apply only to runners that accept a `timeout`, and the real default runner SHALL enforce it.

**Validates: Requirements 3.4, 3.5**

## Fix Implementation

### Changes Required

Assuming the root-cause analysis is correct.

#### Change 1 — Robust `Popen`-based executor (`app/engine/proc.py::ejecutar_comando`)

Replace the `subprocess.run` implementation with a `Popen`-based one that structurally cannot hang for a healthy tool and can forcibly bound an unhealthy one:

1. **Redirect `stdin` from the null device**: `stdin=subprocess.DEVNULL` — no tool blocks waiting for input.
2. **Own process group / session**: `start_new_session=True` (POSIX) so the child and all descendants can be terminated as a unit on timeout. (Windows fallback: `creationflags=CREATE_NEW_PROCESS_GROUP`; termination via `proc.kill()`.)
3. **Concurrent draining of `stdout` and `stderr`**: retain concurrent draining (via `proc.communicate(timeout=...)`, which drains both streams concurrently) so a large-output tool can never deadlock — this is the invariant preserved from the current `subprocess.run` behavior, made explicit for the `Popen` migration.
4. **Bounded timeout**: accept `timeout: Optional[float]` (already in the signature) and pass it to `communicate`. On `subprocess.TimeoutExpired`:
   - kill the **entire process group** (`os.killpg(os.getpgid(proc.pid), SIGTERM)`; after a short grace period, `SIGKILL`);
   - call `communicate()` again to drain any remaining buffered output;
   - raise `ComandoTimeoutError` with an actionable message (command name, timeout value, tail of captured `stderr`).
5. **Actionable, propagating error type**: define `class ComandoTimeoutError(OSError)`. Because every call site already wraps `OSError` into its step-specific error (`NormalizacionError`, `ClipInspeccionError`, `SilenceProcessingError`, `MusicaError`, `TranscripcionError`, `SubtitulosError`, `RemotionError`), a timeout automatically propagates into `{paso, motivo}` with **no change to any call site's except-handling** — the pipeline's existing `_fallo` path then transitions the job to `FALLIDO` (Requirements 2.3, 5.x from bugfix analysis).

Return value on success is byte-for-byte the same `ResultadoComando(returncode, stdout, stderr, args)` as before (Property 2).

#### Change 2 — Carry timeout in the `Runner` contract without breaking single-arg doubles

1. Widen the `Runner` type alias to `Callable[..., ResultadoComando]` and document the optional keyword `timeout: Optional[float] = None`.
2. Add a small adapter in `proc.py`:
   ```
   FUNCTION invocar_runner(runner, args, timeout)
     IF runner accepts a `timeout` parameter (via inspect.signature, cached):
        RETURN runner(args, timeout=timeout)
     ELSE:
        RETURN runner(args)          // single-arg test double → unchanged
   END FUNCTION
   ```
   Detection uses `inspect.signature` (with a `TypeError` fallback) so that single-argument doubles (`__call__(self, args)`) are called exactly as today (Property 5). This is the preservation-critical seam: for the default real runner the timeout is enforced; for single-arg doubles the call is identical to `runner(args)`.
3. Update every engine call site from `resultado = runner(comando)` to `resultado = invocar_runner(runner, comando, timeout=<paso timeout>)`:
   - `ffprobe.py::inspeccionar_clip`
   - `normalize.py::_probar_duracion`, per-clip normalization, transitions, concat
   - `silence.py::obtener_duracion`, `detectar_silencios` (silencedetect), recorte, `cortar_silencios` (auto-editor)
   - `transcribe.py`, `music.py`, `subtitles.py`, `risas.py`, `remotion.py`
   The wrapped call preserves the existing surrounding `try/except OSError` blocks unchanged.

#### Change 3 — Uniform, configurable timeout values (`app/config.py`)

Add env-overridable defaults so operators can tune per environment without code changes:
- `VSE_SUBPROCESS_TIMEOUT_S` — general default (e.g. 900 s).
- `VSE_PROBE_TIMEOUT_S` — short deadline for `ffprobe` inspection/duration (e.g. 60 s), since a valid small clip must probe in well under a second.
- (Optionally) a longer deadline for transcription/render steps.
These bound the fail-fast net; they are intentionally generous so healthy runs on valid inputs never trip them (Property 2 / edge case).

#### Change 4 — UNIR sub-step observability (`app/engine/normalize.py`, `app/engine/pipeline.py`)

- Add `logger.info` markers in `unir_clips` before/after each sub-step (clip inspection, each per-clip normalization, concat/transitions) so a stall is visible in logs rather than silent (Requirement 2.5). Logging has no effect on outputs (preservation-safe).
- Optionally emit intermediate progress within the UNIR range (0–25 %) so the UI advances during multi-clip normalization; the value stays monotonic non-decreasing per the JobManager contract.

#### Change 5 — No partial output referenced on timeout (already structurally satisfied)

On timeout mid-normalization, `ComandoTimeoutError` → step-specific error → pipeline `_fallo`; the `unido`/`cortado` path is never returned as success, and `JobRunner` cleans the workdir. This design confirms and preserves that guarantee (Requirement 2.6); no new code is required beyond the propagating error type.

### Files touched (summary)

- `app/engine/proc.py` — new executor, `ComandoTimeoutError`, `invocar_runner`, widened `Runner` type.
- `app/config.py` — timeout constants.
- `app/engine/{ffprobe,normalize,silence,transcribe,music,subtitles,risas,remotion}.py` — call sites routed through `invocar_runner` with a per-step timeout.
- `app/engine/{normalize,pipeline}.py` — UNIR sub-step logging/progress.

No changes required to `JobManager`/`JobRunner`/`pipeline` failure routing — the existing `OSError`→step-error→`_fallo`→`FALLIDO {paso, motivo}` chain carries timeouts once `ComandoTimeoutError` derives from `OSError`.

## Testing Strategy

### Validation Approach

Two-phase: first surface counterexamples that demonstrate the hang/deadlock behavior on the UNFIXED code, then verify the fix bounds termination, drains without deadlock, and preserves all existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the unbounded wait BEFORE implementing the fix, and confirm/refute the root-cause hypotheses.

**Test Plan**: Drive `ejecutar_comando` (and a call site such as `inspeccionar_clip`) with a **real** child process that blocks (e.g. a tiny script that sleeps far longer than any reasonable deadline, or reads `stdin` forever), under a bounded wall-clock guard in the test harness. On UNFIXED code the executor never returns within the guard; on FIXED code it raises `ComandoTimeoutError` promptly. A separate exploratory test spawns a child that writes a large volume to `stderr` to characterize draining behavior.

**Test Cases**:
1. **Unbounded wait (headline)**: a child that sleeps effectively forever; assert the call does not return within a generous wall-clock guard on unfixed code (will hang), and returns/raises quickly once a timeout is enforced.
2. **Blocked-on-stdin**: a child that reads `stdin` until EOF while the parent never writes; demonstrates the inherited-stdin stall on unfixed code.
3. **Grandchild survival**: a child that spawns a long-lived grandchild; demonstrates that killing only the direct child is insufficient (motivates process-group kill).
4. **Large-stderr characterization**: a child emitting > 64 KB to `stderr`; confirm current `subprocess.run` does not deadlock (refuting a *current* pipe-buffer deadlock) and pin this as an invariant the `Popen` fix must preserve.

**Expected Counterexamples**:
- On unfixed code, cases 1–2 do not terminate within the guard (silent, no output surfaced) — reproducing "stuck at 25 %, zero logs".
- Case 3 shows an orphaned grandchild after direct-child termination.
- Case 4 confirms no current deadlock, so the deadlock property is a preservation/regression guard for the migration to `Popen`.

Because this bug is a deterministic block (not random), scope the property-based exploration test to the concrete blocking cases above for reproducibility, guarded by a hard wall-clock cap so the test suite itself never hangs.

### Fix Checking

**Goal**: For all inputs where the bug condition holds, the fixed executor produces bounded termination.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := ejecutar_comando'(input.args, timeout=input.deadline)
  ASSERT terminates_within(result, input.deadline + grace)
  ASSERT result.succeeded
      OR (result RAISED ComandoTimeoutError
          AND pipeline maps it to FALLIDO with {paso, motivo}
          AND process_group_terminated(input)
          AND no_partial_output_referenced(input))
END FOR
```

### Preservation Checking

**Goal**: For all inputs where the bug condition does NOT hold, the fixed executor/pipeline behaves identically to the original.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT ejecutar_comando(input) == ejecutar_comando'(input)     // same ResultadoComando
  ASSERT pipeline(input) == pipeline'(input)                     // same artifacts, order, errors
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation because the guarantees are universal ("for all non-buggy inputs / all injected doubles / all clip orders"). Observe behavior on UNFIXED code first, then encode it.

**Test Plan**: Observe outputs on unfixed code for (a) successful runs via injected doubles, (b) non-zero exits, (c) clip-order round-trips, then write property-based tests asserting the fixed code matches.

**Test Cases**:
1. **Successful-run equivalence**: injected runner returning `returncode=0` yields the same `ResultadoComando` and the same produced artifacts before and after the fix.
2. **Non-zero exit equivalence**: injected runner returning non-zero still raises the same step-specific error with the same motive.
3. **Order preservation**: for random `Orden_de_Clips`, `contenido_concat_txt` / `unir_clips` preserve order identically (existing Hypothesis property must still pass).
4. **Single-arg double compatibility**: a runner double with `__call__(self, args)` (no `timeout`) is invoked through `invocar_runner` without `TypeError`, identical to `runner(args)`.
5. **Standalone/local unaffected**: local-mode configuration path unchanged.

### Unit Tests

- `ejecutar_comando` success path returns exact `ResultadoComando`; `stdin` is the null device; child runs in its own process group.
- Timeout path raises `ComandoTimeoutError`, kills the process group (no orphaned grandchildren), and includes an actionable message with captured `stderr` tail.
- `ComandoTimeoutError` is an `OSError` and is wrapped by each call site into its step-specific error (spot-check `NormalizacionError`, `ClipInspeccionError`, `SilenceProcessingError`).
- `invocar_runner` dispatches with/without `timeout` based on the double's signature.
- Config timeout constants respect env overrides.

### Property-Based Tests

- **No-deadlock draining (Property 3)**: for generated output sizes (including >> pipe buffer), the executor captures full output and terminates without deadlock.
- **Backward-compatible injection (Property 5)**: for generated runner doubles of both shapes (single-arg and timeout-aware), `invocar_runner` succeeds and returns the double's result.
- **Order preservation (Property 4)**: existing concat-order Hypothesis property re-run against fixed code.
- **Preservation of successful runs (Property 2)**: generated injected-runner scenarios produce identical results pre/post fix.

### Integration Tests

- Full UNIR step with injected doubles: two valid clips → `unido.mp4` produced, order preserved, progress advances through the UNIR sub-steps.
- Timeout during UNIR (injected/real blocking tool) → job transitions to `FALLIDO` with `error = {"paso": "UNIR", "motivo": ...}` surfaced via the progress reporter, and the workdir is cleaned (no partial artifact referenced).
- Standalone/local end-to-end smoke path behaves as before for valid inputs.
