# UNIR / CORTAR_SILENCIOS Stall — Diagnostic-First Bugfix Design (Iteration 2)

## Overview

An edit job launched from the generator in Cloud Run (branch
`feat/gcloud-migration`), over previously generated clips whose source files live
in the bucket and **with silence editing enabled**, still stalls: the last
observed progress is **25%**, the UI shows **«Unir»**, and the silence-editing
timeline never mounts. This is the **second iteration** of the fix.

The **first iteration treated an unbounded subprocess wait (`timeout=None`) and
direct-child-only termination as the confirmed root cause and shipped a
`Popen`-based executor with `stdin=DEVNULL`, concurrent draining, a process-group
kill, bounded per-step timeouts, and a `ComandoTimeoutError` that propagates to
`FALLIDO {paso, motivo}`.** Those mechanisms are now **implemented and present**
in `app/engine/proc.py` and `app/config.py`. **Therefore the timeout / `Popen`
hypothesis is no longer a confirmed cause** — the failure persists despite the
fix. The percentage 25 alone cannot tell us whether `UNIR` finished, whether
silence detection started, or which step / substep / state is active.

This design is **diagnostic-first**. Its purpose is not to assert a new root
cause but to make the transitions at the 25% boundary **observable** and to
gather **correlated evidence** (version, revision, `editJobId`, `editorJobId`,
step, substep, state, event type) end-to-end across Next.js and FastAPI so any
affected job can be **classified** into one of four categories — without
attributing causality that the evidence does not yet support. It also hardens
**deployment identity** so we can prove *which build/revision* actually served a
request, and adds a **preflight** that fails fast (with versions) when the
runtime environment is not what we expect.

### Strongest current hypothesis (explicitly a hypothesis, not a confirmation)

Because bounded timeouts already exist (a genuinely blocked `ffmpeg`/`ffprobe`
would now trip `ComandoTimeoutError` → `FALLIDO`, not hang forever) and `UNIR`
already emits per-substep logs, the **strongest hypothesis** is that a UI stuck
at 25% is most likely **(c)** a real pause (`ESPERANDO_EDICION_SILENCIOS`) whose
transition/propagation is **not visible** to the browser (mapping, reconciliation
timing, monitor lifecycle, or a lost editor job surfaced as `EDITOR_STATE_LOST`),
**or (d)** the browser is running an **old revision/config** (a deploy that
didn't actually ship). This is a ranking to guide diagnosis, **not** a confirmed
diagnosis; the instrumentation must be able to **confirm or refute** it.

### Design strategy (in priority order)

1. **Deployment identity** — prove which build/revision is live (manual
   identifier next to `AUGC Pipeline`, coherent with `getAppVersion()` and
   `/api/version`; `K_REVISION` in server-side diagnostics).
2. **Preflight & environment truth** — verify `ffmpeg`/`ffprobe` availability
   **and versions** at editor startup with structured logs; verify the
   control-plane "CPU always allocated" / `--no-cpu-throttling` setting with a
   **post-deploy check** (not by pretending the container can infer it).
3. **Correlated, unambiguous events** — differentiated events for every substep
   around the 25% boundary, carrying full correlation, so the last confirmed
   event localizes the stall. Percentage stays monotonic but is **never** used as
   the state.
4. **Classification** — a diagnostic tree/matrix that maps the last confirmed
   event to one of four categories.
5. **Failure hardening** — keep the existing terminal timeout failure; enrich its
   message with substep/correlation when missing.

All of this is **additive and observation-only**: it must not change the
pipeline's outputs, ordering, immutability guarantees, local-mode behavior, or
the isolation of the separate "+7 seconds" clip-extension flow.

## Glossary

- **Bug_Condition (C)**: An edit-job observation in Cloud Run where silences are
  enabled, the last confirmed progress is 25%, the silence timeline is not
  mounted, and the system **cannot** yet classify the job (no correlated evidence
  of version/revision/step/substep/state). Formally `C(X)` below.
- **Property (P)**: For any `X` satisfying C, the fixed system emits
  differentiated events with full correlation so `X` is **classifiable** into one
  of four categories, the pause either **propagates to the timeline** or ends in
  an **actionable terminal failure**, and neither depends on the raw percentage.
- **Preservation**: For any input **not** satisfying C — successful runs, silences
  disabled, local mode, the +7s flow, clip ordering/selection, input
  immutability, the already-shipped timeout behavior — the fixed code produces
  the same observable result as today.
- **F**: The current code on `feat/gcloud-migration` (timeouts + `Popen` executor
  already present; opaque at 25%, un-classifiable).
- **F'**: The instrumented code (deployment identity, preflight with versions,
  correlated differentiated events, enriched terminal failure, classification).
- **25% boundary**: In `app/engine/pipeline.py`, `RANGOS_PASOS` assigns
  `UNIR = (0, 25)` and `CORTAR_SILENCIOS = (25, 40)`. After `fn_unir`/`unir_clips`
  the pipeline reports UNIR's upper edge (25%, «Clips unidos»); with silences
  enabled it then reports CORTAR_SILENCIOS's lower edge (still **25%**) for
  «Detectando silencios» and again for «Esperando edición manual de silencios».
  **Multiple distinct substeps therefore share the value 25.**
- **UNIR (`unir_clips`)**: `app/engine/normalize.py`; per-clip `ffprobe`
  inspection → per-clip normalization to 9:16 → concat (`concat.txt` + demuxer or
  `xfade`/`acrossfade`). Already logs `UNIR: …` markers per substep.
- **CORTAR_SILENCIOS — FASE A (detection)**: `detectar_silencios`
  (`app/engine/silence.py`) runs `silencedetect` (or VAD) on the **joined** video
  **without cutting**, then the pipeline returns
  `ResultadoPipeline(pendiente_edicion_silencios=True, unido, silencios,
  duracion_unido_s)`.
- **`marcar_esperando_edicion_silencios`**: `JobRunner.ejecutar_job` (via
  `JobManager`) persists state `ESPERANDO_EDICION_SILENCIOS` and does **not** clean
  the workdir (intermediates are needed to resume).
- **`statusMap.ts`**: maps editor estado `esperando_edicion_silencios` →
  `awaiting_silences`; an unknown estado → `failed` with
  `{paso:"STATUS_MAPPING", motivo}`.
- **`jobReconciler.ts`**: `reconcileEditJob` polls the editor `/progreso`,
  checks durable output first, maps estado via `statusMap`, and on a 404
  (`EditorPermanentError`) for a paused job sets `failed`
  `{paso:"EDITOR_STATE_LOST", motivo}`. `launchEditJobMonitor` runs a detached
  in-process poll loop with backoff.
- **`controlForStatus` / `SilenceTimeline`**: `EditPanel.tsx` mounts
  `SilenceTimeline` when `controlForStatus(status) === "silence"` (i.e.
  `awaiting_silences`), while polling `/api/edit/[id]/progress` every 2 s.
- **Deployment identity**: `getAppVersion()` (`src/lib/version.ts`) reads
  `NEXT_PUBLIC_APP_VERSION` / `NEXT_PUBLIC_BUILD_TIME` (baked at build time via the
  Dockerfile `APP_VERSION` build-arg fed by `cloudbuild.yaml` `_TAG`);
  `VersionBanner` (`src/components/VersionBanner.tsx`) is the fixed bottom-right
  chip; `GET /api/version` (`src/app/api/version/route.ts`) returns the same
  values; the title `AUGC Pipeline` lives in `src/app/layout.tsx`.
- **Manual identifier**: the exact human string `v0.9123 banana xD`, shown next
  to `AUGC Pipeline`, baked once via env, separate (space-delimited) from the
  Docker image tag.
- **K_REVISION**: the Cloud Run revision name injected by the platform into the
  container environment; used only in **server-side** diagnostics, never exposing
  secrets.
- **CPU always allocated**: a Cloud Run **control-plane** property
  (`--no-cpu-throttling`), **not** something the container can reliably infer;
  verified by a **post-deploy** check.
- **Correlation tuple**: `{version, revision (K_REVISION), editJobId,
  editorJobId, step (paso), substep (subpaso), state (estado), eventType}` — the
  fields every diagnostic event must carry. **Video content is never logged.**

## Bug Details

### Bug Condition

The bug manifests when an edit job runs in Cloud Run cloud mode
(`EDIT_MODE=cloud`, `VSE_STORAGE_BACKEND=volume`) over bucket-backed clips with
silences enabled, the last confirmed progress observation is **25%**, the
silence-editing timeline has **not** mounted, and the available evidence is
**insufficient to classify** the job. Concretely, the observer cannot tell —
from the percentage alone or from the current logs/progress — whether `UNIR`
completed, whether silence detection started or finished, whether the pause
`ESPERANDO_EDICION_SILENCIOS` was reached and mapped to `awaiting_silences`, or
whether the browser is even running the expected build/revision.

**Formal Specification:**
```
FUNCTION isBugCondition(X)
  INPUT: X of type EditJobObservation
  OUTPUT: boolean

  RETURN X.mode == "cloud"
     AND X.silencesEnabled
     AND X.lastConfirmedPercent == 25
     AND NOT X.timelineMounted
     AND NOT canClassify(X)   // no correlated evidence assigns X to a category
END FUNCTION

// canClassify requires a correlation tuple + a "last confirmed event" that
// places X into exactly one of {A, B, C, D} (see Diagnostic Matrix).
FUNCTION canClassify(X)
  RETURN hasCorrelationTuple(X)
     AND hasLastConfirmedEvent(X)
     AND category(X) IN {A, B, C, D}
END FUNCTION
```

**Expected behavior for a buggy input (the target of the fix):**
```
FUNCTION expectedBehavior(X, result)
  RETURN emitsDifferentiatedEvents(result)  // UNIR-done, detect-start, detect-done, pause
     AND carriesCorrelation(result)         // version, revision, editJobId, editorJobId, step, substep, state, eventType
     AND classifiable(result INTO {A, B, C, D})
     AND ( pausePropagatedToTimeline(result)   // awaiting_silences → SilenceTimeline mounts
           OR terminalActionableFailure(result) )  // FALLIDO {paso, subpaso, motivo}
     AND stateIndependentOfPercent(result)    // step/substep/state can change while % stays 25
END FUNCTION
```

### Examples

- **Headline (opaque stall):** Cloud Run, 2 valid ~8 s bucket clips, silences on.
  UI sits at 25% «Unir», no timeline. Current logs/progress cannot say whether
  `UNIR` finished or detection started. *Expected after F':* the last confirmed
  event pinpoints the substep, and the job is classified A/B/C/D.
- **Category C (un-propagated pause):** FastAPI reached
  `ESPERANDO_EDICION_SILENCIOS` and persisted it, but the browser never showed the
  timeline (mapping/reconciliation/monitor timing, or a 404 →
  `EDITOR_STATE_LOST`). *Expected:* `awaiting_silences` events with correlation
  make the pause visible, or an actionable `EDITOR_STATE_LOST` failure is shown.
- **Category D (stale deploy):** the browser runs an old bundle; the header does
  not show `v0.9123 banana xD`, or the header value disagrees with
  `/api/version`. *Expected:* identity mismatch is immediately visible.
- **Category A/B (genuine block):** if `ffprobe`/`ffmpeg` or detection truly
  blocked, the existing bounded timeout should now produce a terminal
  `FALLIDO {paso, motivo}`; the enriched message adds substep/correlation. A
  persistent 25% with **no** timeout firing is itself evidence *against* A/B and
  *for* C/D.
- **Edge (silences disabled):** no pause; the pipeline proceeds past 25% to
  TRANSCRIBIR. Must be unaffected.

## Expected Behavior

### Preservation Requirements

**Unchanged behaviors (must not regress):**
- Clip **selection and order** — all and only the selected clips, exactly once,
  in the requested order (`orden_clips` → `unir_clips`/`contenido_concat_txt`).
- **Input immutability** — source objects are read byte-for-byte; outputs and
  temporaries are written only to separate destinations (workdir / output).
- **Local mode** (`EDIT_MODE=local`, `VSE_STORAGE_BACKEND=local`) works
  independently of Cloud Run metadata/services.
- **Flow isolation** — the silence/edit flow and the separate "+7 seconds"
  clip-extension flow stay decoupled in both directions (no shared triggers,
  states, or changes).
- **Existing timeout/`Popen` guarantees** — `stdin=DEVNULL`, concurrent
  draining, process-group kill, bounded per-step timeouts, and
  `ComandoTimeoutError` → `FALLIDO {paso, motivo}` remain; **no new timeout
  values are introduced or assumed.**
- **Pause semantics** — with silences enabled and detection complete, the joined
  video and detected segments are preserved during the pause, the timeline is
  presented, and transcription/later steps do not start before the pause ends;
  with silences disabled, no pause and no timeline.
- **Monotonic percentage** — progress percentage stays monotonic non-decreasing;
  state/substep are independent of it and may change while it stays at 25.

**Scope:** every input that does NOT satisfy the bug condition must be completely
unaffected. Diagnostic changes are **observation-only** (logging, event
metadata, a startup preflight, a UI/text identifier, a post-deploy check) and
must not alter pipeline outputs. The concrete correct behavior for buggy inputs
is defined in the Correctness Properties below.

## Hypothesized Root Cause

Ranked from most to least likely, given that timeouts/`Popen` are **already
shipped** and `UNIR` already logs per-substep. **These are hypotheses to confirm
or refute with the new instrumentation, not confirmed causes.**

1. **(C) Reached-but-un-propagated pause — STRONGEST HYPOTHESIS (not a
   confirmation).** FastAPI likely reaches `ESPERANDO_EDICION_SILENCIOS` and
   persists it, but the browser never mounts `SilenceTimeline`. Candidate
   mechanisms to examine: `reconcileEditJob`/`launchEditJobMonitor` timing or
   lifecycle; the estado→status mapping; a small race with `detectDurableOutput`;
   or a 404 on the editor job (container/in-memory loss) surfaced as
   `EDITOR_STATE_LOST`. The 25% freeze with **no timeout firing** points here
   rather than at a genuine tool block.
2. **(D) Stale revision/config deployed — STRONG HYPOTHESIS (not a
   confirmation).** The browser may be running an old build (deploy didn't ship,
   cached bundle, wrong revision serving). Today there is no unambiguous,
   in-product way to confirm the live build/revision, so a "nothing changed after
   deploy" symptom is easy to misread.
3. **(A) `ffmpeg`/`ffprobe` blocked before `UNIR` completes (less likely now).**
   A genuine block should now be cut by the bounded per-step timeout →
   `ComandoTimeoutError` → `FALLIDO`. Still possible if the block occurs outside a
   bounded call, or if the environment differs (missing/incompatible binary,
   CPU-throttled revision), which the preflight/post-deploy check targets.
4. **(B) Silence detection blocked (less likely now).** Same reasoning as A for
   the detection substep (`silencedetect`/VAD + `obtener_duracion`).

**Four diagnostic categories (requirement 2.3 / 1.3):**
- **A** — ffmpeg/ffprobe blocked before finishing `UNIR`.
- **B** — silence detection blocked.
- **C** — union & detection complete, but pause transition/propagation not
  visible (mapping/reconciliation/monitor/`EDITOR_STATE_LOST`).
- **D** — an old revision or a different-than-expected configuration is deployed.

## Correctness Properties

Property 1: Bug Condition — Differentiated, Correlated Diagnosability at the 25% Boundary

_For any_ edit-job observation where the bug condition holds (`isBugCondition`
returns true), the fixed system SHALL emit **differentiated** events for
UNIR-completion, silence-detection start, silence-detection completion, and the
`ESPERANDO_EDICION_SILENCIOS` pause — each carrying the full correlation tuple
(version, revision/`K_REVISION`, `editJobId`, `editorJobId`, step, substep,
state, event type) — such that the job is **classifiable** into exactly one of
the four categories A/B/C/D from its last confirmed event, and the step/substep/
state change independently of the percentage (which stays 25). Video content
SHALL NOT be logged.

**Validates: Requirements 2.1, 2.2, 2.3, 2.5**

Property 2: Preservation — Identical Pipeline Behavior for Non-Buggy Inputs

_For any_ input where the bug condition does NOT hold (successful runs, silences
disabled, local mode, the +7s flow, any clip ordering/selection), the fixed code
SHALL produce the same observable result as the original: same selected clips in
the same order, byte-for-byte input immutability, unchanged pause/no-pause
semantics, unchanged local-mode behavior, unchanged flow isolation, and a
monotonic percentage — preserving all current behavior. Diagnostic additions are
observation-only and SHALL NOT change outputs.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.6, 3.7, 3.8**

Property 3: Deployment Identity Coherence

_For any_ served page and API response from a given build/revision, the header
next to `AUGC Pipeline` SHALL display the exact manual identifier
`v0.9123 banana xD` (with the bottom `VersionBanner` preserved), and `GET
/api/version` SHALL expose the same identifier; both SHALL correspond to the same
build and the same revision serving the request. The Docker image tag SHALL be
space-separated from the manual identifier, and `K_REVISION` SHALL appear only in
server-side diagnostics without exposing secrets.

**Validates: Requirements 2.8, 2.9**

Property 4: Preflight & Deploy-Time Environment Verification

_For any_ revision about to process edit jobs, the editor (FastAPI) SHALL verify
in the **effective** environment that `ffmpeg` and `ffprobe` are available, can
execute, and **report their versions** (structured logs); if this preflight
fails it SHALL prevent processing with an actionable, correlated failure and no
partial results. The "CPU always allocated" / `--no-cpu-throttling` control-plane
setting SHALL be verified by a **post-deploy** step (e.g. `gcloud run services
describe` / a Cloud Build or runbook check) that **fails if it does not match** —
never inferred from inside the container.

**Validates: Requirements 2.6**

Property 5: Terminal Timeout Failure Preserved and Enriched

_For any_ operation that reaches its timeout without completing, the system SHALL
continue to drive the job to the terminal `FALLIDO` state (existing behavior,
discarding partial output) and SHALL enrich the failure message with the substep
and correlation tuple when missing — without introducing or assuming new timeout
values.

**Validates: Requirements 2.7, 3.5**

## Fix Implementation

Assuming the diagnostic-first plan is correct. All changes are **additive and
observation-only** unless stated; none alter pipeline outputs.

### Change 1 — Deployment identity next to `AUGC Pipeline`

**Files:** `src/app/layout.tsx`, `src/lib/version.ts`, `src/app/api/version/route.ts`
(behavioral confirmation), `src/components/VersionBanner.tsx` (kept as-is),
Dockerfile / `cloudbuild.yaml` (build-arg wiring).

- Render the exact manual identifier `v0.9123 banana xD` beside the `AUGC
  Pipeline` title in `layout.tsx`, keeping the fixed bottom-right `VersionBanner`.
- Bake the identifier **once** via env so it is inlined at build time and stays
  consistent with `getAppVersion()` and `GET /api/version` for the same build.
- **Separate** the Docker image tag from the manual identifier with spaces (e.g.
  `"<image-tag> v0.9123 banana xD"`) so both are visible and unambiguous.
- Add `K_REVISION` to **server-side** diagnostics only (never rendered as a
  secret, never exposing credentials).

### Change 2 — Editor preflight with `ffmpeg`/`ffprobe` versions + structured logs

**Files:** `editor/app/deps/checker.py`, `editor/main.py` (lifespan), possibly a
small helper in `editor/app/engine/proc.py` (reuse `ejecutar_comando`).

- Extend the startup verification so `ffmpeg`/`ffprobe` are not only located
  (`shutil.which`, current behavior) but **executed with `-version`** to capture
  and log their versions in a **structured** form. Keep the bounded execution via
  the existing `ejecutar_comando` (with a probe-sized timeout); a failure marks
  the dependency unavailable and **blocks startup** (existing `main.py` contract),
  producing an actionable, correlated message.
- **CPU always allocated is NOT inferred in-container.** Document and implement a
  **post-deploy** verification step (Change 6) that inspects the control-plane
  setting; the container preflight only records the environment it actually sees.

### Change 3 — End-to-end correlated events (Next.js + FastAPI)

**Files (FastAPI):** `editor/app/api/process.py` (`/procesar`),
`editor/app/api/progress.py`, `editor/app/jobs/runner.py`,
`editor/app/jobs/manager.py`, `editor/app/engine/pipeline.py`.
**Files (Next.js):** `src/lib/edit/jobReconciler.ts`, `src/lib/edit/statusMap.ts`,
`src/components/edit/EditPanel.tsx` (+ `editUiData.ts`),
`src/app/api/edit/[editJobId]/progress` route.

- Attach the **correlation tuple** `{version, revision (K_REVISION), editJobId,
  editorJobId, step, substep, state, eventType}` to every relevant log/event at
  job start, per substep, on pause, on timeout, and on failure — across
  `/procesar`, progress polling, and reconciliation.
- **Never log video content**; log only identifiers, counts, durations, sizes,
  and states.

### Change 4 — Unambiguous events for each substep; percentage ≠ state

**Files:** `editor/app/engine/normalize.py` (`unir_clips`),
`editor/app/engine/silence.py` (`detectar_silencios`),
`editor/app/engine/pipeline.py`, `editor/app/jobs/runner.py`
(`marcar_esperando_edicion_silencios`), and the Next reconciler/UI.

Emit distinct, correlated events for:
1. **Materialization** from the bucket (cloud/volume input resolution).
2. **`ffprobe` per clip** (inspection start/done, per clip).
3. **Normalization per clip** (start/done, per clip).
4. **Concat** (start/done).
5. **Silence detection** (start/done, segment count, duration).
6. **`marcar_esperando_edicion_silencios`** (pause reached, `awaiting_silences`).
7. **Reconciliation / state mapping** (`reconcileEditJob`, `mapEditorEstado`,
   including `EDITOR_STATE_LOST`).
8. **Timeline mount** in the UI (`controlForStatus === "silence"` →
   `SilenceTimeline` mounted).

The percentage remains **monotonic** but is **never** used as the state; the
step/substep/state carry the truth and can change while the percentage stays 25.

### Change 5 — Preserve and enrich the terminal timeout failure

**Files:** `editor/app/engine/pipeline.py` (`_fallo`), `editor/app/jobs/runner.py`.

- Keep the existing `ComandoTimeoutError` → step-specific error →
  `FALLIDO {paso, motivo}` chain unchanged. **Enrich** the motive with the
  substep and correlation tuple when they are missing, so a terminal failure is
  immediately localizable. Do **not** introduce or assume new timeout values.

### Change 6 — Post-deploy control-plane verification (runbook + check)

**Files:** `cloudbuild.yaml` (a post-deploy verification step) and/or a runbook
in `DEPLOY.md`.

- After deploy, verify with `gcloud run services describe` (or an equivalent
  Cloud Build step) that the live revision has **CPU always allocated**
  (`--no-cpu-throttling`), the expected image tag, and `min=max=1`. The step
  **fails the deploy** if the setting does not match — closing the gap between
  declared config and effective revision.

### Files touched (summary)

- **Next.js:** `src/app/layout.tsx`, `src/lib/version.ts`,
  `src/app/api/version/route.ts` (confirm), `src/components/VersionBanner.tsx`
  (unchanged), `src/lib/edit/jobReconciler.ts`, `src/lib/edit/statusMap.ts`,
  `src/components/edit/EditPanel.tsx`, `src/components/edit/editUiData.ts`,
  `src/app/api/edit/[editJobId]/progress` route.
- **FastAPI:** `editor/app/deps/checker.py`, `editor/main.py`,
  `editor/app/api/process.py`, `editor/app/api/progress.py`,
  `editor/app/jobs/runner.py`, `editor/app/jobs/manager.py`,
  `editor/app/engine/normalize.py`, `editor/app/engine/silence.py`,
  `editor/app/engine/pipeline.py`.
- **Deploy:** `Dockerfile` / `cloudbuild.yaml` / `DEPLOY.md` (identifier baking +
  post-deploy check).

## Diagnostic Decision Matrix

From the **last confirmed correlated event**, classify the affected job:

| Last confirmed event (correlated)                                             | Timeout fired? | Timeline mounted? | Category | Interpretation |
|-------------------------------------------------------------------------------|:--------------:|:-----------------:|:--------:|----------------|
| `ffprobe`/normalization/concat **started** for `UNIR`, never a "done" event   | no             | no                | **A**    | ffmpeg/ffprobe blocked before `UNIR` finished |
| `UNIR` **done**; silence-detection **started**, never "done"                  | no             | no                | **B**    | silence detection blocked |
| silence-detection **done** and/or `ESPERANDO_EDICION_SILENCIOS` **persisted** | no             | no                | **C**    | pause reached but transition/propagation not visible (mapping/reconcile/monitor/`EDITOR_STATE_LOST`) |
| header/`/api/version` identifier **mismatch** or missing `v0.9123 banana xD`  | n/a            | no                | **D**    | old revision / different config deployed |
| any substep reached its bound and produced `FALLIDO {paso, subpaso, motivo}`  | **yes**        | no                | A or B   | genuine block — already cut by the existing timeout; read `{paso, subpaso}` |

Guidance consistent with the strongest hypothesis: a persistent 25% with **no
timeout firing** argues **against A/B** and **for C or D**.

## Operational Diagnostic Checklist (guidance only — do NOT execute or modify infra here)

Suggested read-only observations to gather correlated evidence for the current
deploy on `feat/gcloud-migration` (run manually, outside this design task; do not
change infrastructure):

- Confirm the live build/revision: open the app and check the header shows
  `v0.9123 banana xD`; `curl` `GET /api/version` and confirm it matches.
- Inspect the running revision and its CPU/throttling/instances:
  `gcloud run services describe <service> --region <region>` and confirm
  *CPU always allocated* / `--no-cpu-throttling` and `min=max=1`.
- Tail structured logs for the affected `editJobId`/`editorJobId` and read the
  **last confirmed event** (step/substep/state) to place the job in A/B/C/D.
- Confirm the editor preflight logged `ffmpeg`/`ffprobe` **versions** at startup.
- Check whether reconciliation surfaced `EDITOR_STATE_LOST` (points to C via a
  lost editor job) versus a genuine `FALLIDO {paso, motivo}` (points to A/B).

These are **observations**, not fixes; none of them execute here and none change
infrastructure.

## Testing Strategy

### Validation Approach

Two-phase: first surface counterexamples that reproduce the "opaque at 25%,
un-classifiable" symptom on the current code; then verify the instrumentation
makes the transitions observable and classifiable **without** changing pipeline
outputs, ordering, immutability, local mode, or the +7s flow.

Real test locations:
- **Python:** `editor/tests/` (`pytest` + `hypothesis`).
- **TypeScript:** `src/lib/edit/__tests__/` and `src/app/api/edit/__tests__/`
  (`vitest` + `fast-check`).

### Exploratory Bug Condition Checking

**Goal:** Surface counterexamples that demonstrate the un-classifiable 25% stall
BEFORE instrumenting, and confirm/refute the ranked hypotheses (strongest: C/D).

**Test Plan:** Drive the pipeline to the 25% boundary with silences enabled using
injected doubles (no real binaries) and assert that, on the **current** code,
there is **no** correlated event sequence that lets an observer distinguish
UNIR-done vs detection-started vs pause-reached (all report percentage 25). On
the Next side, drive `reconcileEditJob` with an editor progress of
`esperando_edicion_silencios` and assert the mapping/monitor path; drive a 404 to
observe `EDITOR_STATE_LOST`.

**Test Cases (expected to expose the gap on current code):**
1. **Opaque 25% (Python):** run `ejecutar_pipeline` with silences on and
   injected `fn_unir`/`fn_detectar`; assert three progress events at 25% that are
   currently indistinguishable by step/substep/state metadata.
2. **Pause propagation (TS):** `reconcileEditJob` with estado
   `esperando_edicion_silencios` → assert it should map to `awaiting_silences`
   and mount the timeline (`controlForStatus === "silence"`).
3. **Lost editor job (TS):** editor 404 for a paused job → assert
   `EDITOR_STATE_LOST` failure is surfaced (category C).
4. **Identity mismatch (TS):** header identifier vs `GET /api/version` disagree →
   assert this is detectable (category D).

Because this is a deterministic diagnosability gap (not random), scope the
property-based exploration to the concrete boundary cases above, each guarded by
a hard wall-clock cap so the suite never hangs.

### Fix Checking

**Goal:** For all inputs where the bug condition holds, the instrumented system
emits differentiated correlated events, is classifiable, and propagates the pause
or fails terminally.

**Pseudocode:**
```
FOR ALL X WHERE isBugCondition(X) DO
  result := run_instrumented(X)
  ASSERT emitsDifferentiatedEvents(result)
  ASSERT carriesCorrelation(result)
  ASSERT classifiable(result INTO {A, B, C, D})
  ASSERT pausePropagatedToTimeline(result) OR terminalActionableFailure(result)
  ASSERT stateIndependentOfPercent(result)
END FOR
```

### Preservation Checking

**Goal:** For all inputs where the bug condition does NOT hold, the instrumented
code behaves identically to today.

**Pseudocode:**
```
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT pipeline(X)  == pipeline'(X)     // same artifacts, order, immutability
  ASSERT localMode(X) == localMode'(X)    // unchanged standalone behavior
  ASSERT plus7sFlow(X) == plus7sFlow'(X)  // isolation preserved
  ASSERT percentMonotonic(X)              // unchanged monotonic percentage
END FOR
```

**Testing Approach:** Property-based testing (Hypothesis / fast-check) for the
universal preservation guarantees (all clip orders, all non-buggy inputs,
identifier coherence), observation-first: record current outputs, then assert the
instrumented code matches.

### Unit Tests

- **Python (`editor/tests/`):** differentiated correlated events emitted by
  `unir_clips` (per-clip `ffprobe`/normalization/concat), `detectar_silencios`
  (start/done), and `marcar_esperando_edicion_silencios` (pause); preflight logs
  `ffmpeg`/`ffprobe` versions and blocks startup on failure; enriched terminal
  timeout message carries substep/correlation.
- **TS (`src/lib/edit/__tests__/`):** `mapEditorEstado` →
  `esperando_edicion_silencios` = `awaiting_silences`, unknown → `STATUS_MAPPING`
  failure; `controlForStatus("awaiting_silences") === "silence"`.
- **TS (`src/app/api/edit/__tests__/`):** `/api/version` value equals the header
  identifier; progress route carries correlation.

### Property-Based Tests

- **Diagnosability (Property 1):** generated boundary sequences at 25% always
  yield distinguishable, correlated events classifiable into A/B/C/D.
- **Order preservation (Property 2):** for random `orden_clips`,
  `contenido_concat_txt`/`parsear_concat_txt` round-trip equals input and
  `unir_clips` preserves order (reuse existing property).
- **Identity coherence (Property 3):** for generated build identifiers, header
  and `/api/version` agree; the manual identifier and image tag stay
  space-separated.
- **State ≠ percentage (Property 1):** step/substep/state may change while the
  percentage stays 25 and remains monotonic.

### Integration Tests

- **Full transition (Python + TS):** silences on → 25% → `awaiting_silences` →
  `SilenceTimeline` mounted, driven end-to-end with injected doubles; assert the
  correlated event trail and the timeline mount.
- **Preflight failure:** editor startup with a missing/incompatible `ffprobe`
  blocks with an actionable, correlated message and no partial output.
- **Terminal timeout:** an injected `ComandoTimeoutError` during `UNIR` →
  `FALLIDO {paso: "UNIR", subpaso, motivo}` with correlation; no partial
  `unido.mp4` referenced as success.
- **Isolation & local mode:** the +7s flow and local mode behave exactly as
  before.
- **Post-deploy check (runbook/CI):** the control-plane verification fails the
  deploy when `--no-cpu-throttling` / `min=max=1` / image tag do not match.
