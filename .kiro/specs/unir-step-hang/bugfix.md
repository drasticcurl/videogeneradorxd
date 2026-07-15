# Bugfix Requirements Document

## Introduction

When the editor runs in the combined Cloud Run container (Next.js ingress on `:8080` + FastAPI editor on `127.0.0.1:8000`, `EDIT_MODE=cloud`, `VSE_STORAGE_BACKEND=volume`) for the `videogeneradorxd` service, an edit job started with a trivially small, valid input (2 clips of ~8 seconds each) reaches the **UNIR** step (Paso 1) and becomes **stuck at 25% indefinitely**. The job never completes and never fails.

During the hang, the only activity in the Cloud Run logs is the progress polling loop (`GET /api/edit/<id>/progress -> 200` and `GET /progreso/job_<id> -> 200` every ~2 seconds). There is **zero** ffmpeg/ffprobe/pipeline activity, no error, no traceback, and no step change. This strongly indicates that an external subprocess (ffprobe/ffmpeg during clip inspection, per-clip normalization, or the silence detection that immediately follows UNIR) is blocking forever.

The root cause is that external tool invocations run through a `Runner` whose contract does not enforce a bounded timeout. The default runner (`app/engine/proc.py::ejecutar_comando`) accepts a `timeout` argument but defaults it to `None`, and every call site (`normalize.py`, `ffprobe.py`, silence detection) invokes `runner(comando)` with no timeout at all — the `Runner` type signature (`Callable[[Sequence[str]], ResultadoComando]`) does not even carry a timeout parameter. Because the pipeline runs in a background thread via `loop.run_in_executor`, a blocked subprocess freezes the step with no progress update and no failure, which exactly matches the "stuck at 25%, no logs" symptom. A likely trigger in cloud mode is a slow or blocking read from a GCS FUSE-backed input, but any hang in the external tool produces the same unbounded wait.

The impact is severe: an edit job that should finish in seconds hangs forever, consuming the container and giving the generator UI no actionable feedback. The fix must (1) identify and fix the specific root cause of the hang, (2) enforce a bounded timeout and non-deadlocking output draining on all external subprocess invocations (ffmpeg/ffprobe/auto-editor), (3) transition the job to a failed state with an actionable `paso` + `motivo` when a step times out or fails instead of hanging, and (4) improve progress/logging visibility into UNIR sub-steps. Existing standalone/local behavior and the current pytest + hypothesis guarantees must be preserved.

## Bug Analysis

### Current Behavior (Defect)

The following describes what currently happens when a valid edit job runs the UNIR step (and the subprocess-driven work immediately around it) in the combined cloud container.

1.1 WHEN a valid edit job reaches the UNIR step and an external tool invocation (ffprobe clip inspection, ffmpeg per-clip normalization, ffmpeg concat, or the silence detection immediately following UNIR) blocks or reads slowly THEN the system waits on the subprocess indefinitely with no enforced timeout.

1.2 WHEN an external subprocess in the UNIR step blocks THEN the pipeline step (running in the background executor thread) freezes, the reported progress stays fixed (observed at 25%), and the job neither completes nor fails.

1.3 WHEN a subprocess-driven step hangs THEN the system emits no ffmpeg/ffprobe/pipeline activity, no error, no traceback, and no step-change log — the only observable activity is the progress polling loop.

1.4 WHEN an external tool call never returns THEN the system never transitions the job to a failed state and never surfaces an actionable `paso` + `motivo` to the generator UI.

1.5 WHEN any engine module invokes the injected `Runner` (`normalize.py`, `ffprobe.py`, silence detection) THEN the system calls it without a bounded timeout, because the `Runner` contract does not require an enforced execution deadline and the default runner defaults `timeout` to `None`.

### Expected Behavior (Correct)

The following describes what should happen instead for the same conditions.

2.1 WHEN a valid edit job reaches the UNIR step with valid small clips THEN the system SHALL complete UNIR successfully within a bounded time (seconds for such inputs).

2.2 WHEN an external subprocess (ffmpeg/ffprobe/auto-editor) exceeds its enforced bounded timeout THEN the system SHALL terminate the subprocess and stop waiting instead of blocking indefinitely.

2.3 WHEN a subprocess times out or fails THEN the system SHALL transition the job to the failed state with an actionable error containing `paso` and `motivo` that surfaces to the generator UI.

2.4 WHEN any engine module invokes the injected `Runner` for an external tool THEN the system SHALL enforce a bounded timeout and drain stdout/stderr so that a full pipe buffer cannot deadlock the subprocess.

2.5 WHEN the UNIR step executes its sub-steps (clip inspection, per-clip normalization, concatenation/transitions) THEN the system SHALL emit progress and log visibility for those sub-steps so a stall is observable rather than silent.

2.6 WHEN a subprocess is terminated due to a timeout THEN the system SHALL NOT leave partial output artifacts referenced as a successful result.

### Unchanged Behavior (Regression Prevention)

The following existing behavior must be preserved by the fix.

3.1 WHEN a valid edit job runs with valid clips that complete within their timeout THEN the system SHALL CONTINUE TO produce the correct unified 9:16 output and proceed through the pipeline steps as before.

3.2 WHEN an external tool returns a non-zero exit code THEN the system SHALL CONTINUE TO raise the existing step-specific error (e.g. `NormalizacionError` / `ClipInspeccionError`) with the responsible clip and motive, without producing partial output.

3.3 WHEN the editor runs in standalone/local mode (non-cloud, non-volume backend) THEN the system SHALL CONTINUE TO behave as it does today for valid inputs.

3.4 WHEN the existing pytest and hypothesis property-based tests run THEN the system SHALL CONTINUE TO satisfy all current guarantees (pure normalization math, order preservation, homogenization, command construction, injectable runner behavior).

3.5 WHEN tests inject a custom `Runner` double THEN the system SHALL CONTINUE TO support runner injection for simulating success/failure without requiring the real binaries.

3.6 WHEN the clip ordering is provided by the user THEN the system SHALL CONTINUE TO preserve the exact `Orden_de_Clips` in concatenation without reordering, omitting, or duplicating clips.

---

## Bug Condition Derivation

### Bug Condition Function

Identifies the inputs/conditions that trigger the hang: an external tool invocation in the pipeline that is not bounded by an enforced timeout.

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type PipelineStepExecution
  OUTPUT: boolean

  // The step invokes an external tool (ffmpeg/ffprobe/auto-editor) whose
  // subprocess call does not enforce a bounded execution deadline, so a
  // blocking/slow tool causes an unbounded wait.
  RETURN X.invokesExternalTool
     AND NOT X.enforcesBoundedTimeout
END FUNCTION
```

### Property Specification (Fix Checking)

For every step execution that invokes an external tool, the fixed pipeline must terminate within a bounded time — either succeeding or failing with an actionable error — never hanging.

```pascal
// Property: Fix Checking - Bounded termination of external tool steps
FOR ALL X WHERE isBugCondition(X) DO
  result <- runStep'(X)   // F' = pipeline after the fix
  ASSERT terminates_within_bounded_time(result)
     AND ( result.succeeded
           OR (result.failed
               AND result.error HAS paso
               AND result.error HAS motivo) )
     AND NOT hangs_indefinitely(result)
END FOR
```

### Preservation Goal (Preservation Checking)

For all executions that do not meet the bug condition (tools that return within their bounded timeout, standalone/local runs, injected runner doubles), the fixed pipeline behaves identically to the original.

```pascal
// Property: Preservation Checking
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT runStep(X) = runStep'(X)   // F(X) = F'(X)
END FOR
```

**Key Definitions:**
- **F**: The pipeline/runner before the fix (external tool calls with no enforced timeout).
- **F'**: The pipeline/runner after the fix (bounded timeout + output draining + failure on timeout).
- **Counterexample**: An edit job with 2 valid ~8s clips in cloud mode whose UNIR-step ffprobe/ffmpeg read blocks on the GCS FUSE-backed input, leaving the job stuck at 25% forever.
