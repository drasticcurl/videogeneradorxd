# Requirements Document

## Introduction

This feature integrates the **generator** application (`videogeneradorxd`, Next.js/TypeScript, migrating to Cloud Run) with the **editor** application (`ksaljdlkasjdklasd`, Next.js + FastAPI, Python 5-step editing pipeline) so that a user can, from inside the generator UI, hand off generated videos into the editing pipeline, configure editing options, run the job, track progress, preview, and later download the finished short — without leaving the generator app.

Per the approved design, the generator and editor are deployed as **one multi-container Cloud Run service**: the Next.js generator container is the ingress and the FastAPI editor runs as an **internal-only sidecar container**, the two communicating over **localhost** (`http://127.0.0.1:<editor-port>`) within the same instance. Inputs are exchanged between the containers over a **Shared_Volume** (an in-instance ephemeral volume), while durable "download-later" outputs are persisted through videogeneradorxd's **existing GCS storage layer** (the Output_Store). The generator acts as a Backend-For-Frontend (BFF) proxy so the browser only ever talks to the generator origin, and the generator's existing application authentication is the single front door.

This document also captures two confirmed extensions to the design:
- **Clip-based handoff by default**: the editor treats all generated videos as individual clips rather than only the single stitched `final.mp4`.
- **B-roll bank**: a reusable library of b-roll clips the user can browse, manage, and insert into an edit alongside generated clips.
- **Persistent output storage**: edited videos are durably stored to the existing Output_Store and remain retrievable and downloadable at a later time, rather than being downloaded only at the moment of completion.

Both applications MUST continue to operate standalone in local mode with no external services, auth, or GCS required.

## Glossary

- **Generator**: The `videogeneradorxd` Next.js application that produces images and videos with Vertex AI and hosts the integration UI and BFF proxy.
- **Editor_Service**: The `ksaljdlkasjdklasd` FastAPI editor that runs the 5-step editing pipeline (UNIR, CORTAR SILENCIOS, TRANSCRIBIR, SUBTÍTULOS, MÚSICA) and exposes `/procesar`, `/progreso/{id}`, `/descargar/{id}`, `/salud`. In cloud mode it is now an **internal-only sidecar** container within the single Cloud Run service, reachable from the Generator only over `http://127.0.0.1:<editor-port>` (localhost) and never exposed to external ingress.
- **Editor_Handoff**: The Generator BFF layer under `/api/edit/*` that resolves sources, uploads inputs, invokes the Editor_Service, normalizes progress, and serves results.
- **Editor_Client**: The mode-aware typed HTTP client inside the Generator that calls the Editor_Service.
- **Storage_Adapter**: The Generator-side abstraction that places input bytes and reads output bytes (local filesystem or Shared_Volume, delegating durable output persistence to the existing Output_Store).
- **Storage_Backend**: The Editor_Service-side abstraction that materializes input objects into a workdir and persists finished outputs (local filesystem or Shared_Volume, delegating durable output persistence to the existing Output_Store).
- **Shared_Volume**: The in-instance ephemeral volume (an `emptyDir`) mounted into both containers of the single Cloud Run service, used to exchange inputs between the Generator and Editor_Service, namespaced per edit job under `edit-io/<editJobId>/inputs/` and `edit-io/<editJobId>/outputs/`. It is scratch space that dies with the instance.
- **Output_Store**: videogeneradorxd's **existing durable GCS storage layer** (already implemented on `feat/gcloud-migration`), reused for persisting finished edited videos so they remain retrievable and downloadable after job completion. No new dedicated bucket is introduced.
- **Edit_Job**: The Generator-owned entity that wraps exactly one Editor_Service job and mirrors a normalized status and progress.
- **Broll_Bank**: The reusable library of b-roll clips the user can upload, list, and select for insertion into an edit.
- **Broll_Clip**: A single reusable video asset stored in the Broll_Bank.
- **Edit_Mode**: The runtime mode selector (`local` or `cloud`) that determines the deployment topology; `cloud` means the single multi-container Cloud Run service (Generator ingress + Editor_Service sidecar over localhost) with the Shared_Volume and existing Output_Store active, while `local` means both apps run standalone over loopback with on-disk files and no GCS.
- **Edit_Source**: The input selection for an edit job, either the stitched `final.mp4` or an ordered set of individual clips.
- **Edit_Options**: The user-configurable editing settings (silence cut, subtitles, music, clip ordering, and a safe subset of editor Ajustes).
- **MAX_CLIPS_PER_JOB**: The maximum number of clips accepted per edit job (500).

## Requirements

### Requirement 1: Hand off generated videos to the editing pipeline

**User Story:** As a generator user, I want to send my generated videos into the editing pipeline from the generator UI, so that I can produce a finished short without switching applications.

#### Acceptance Criteria

1. WHEN a user submits an edit request whose Edit_Source resolves to at least 1 and at most MAX_CLIPS_PER_JOB existing source artifacts and whose Edit_Options pass validation, THE Editor_Handoff SHALL resolve the source artifacts, write them to the Shared_Volume inputs prefix, invoke the Editor_Service `/procesar` endpoint, create an Edit_Job with initial status queued, and return the editJobId with HTTP 202.
2. WHERE the edit request specifies clip-based editing, THE Editor_Handoff SHALL treat each selected generated video as an individual clip in the orden_clips list sent to the Editor_Service.
3. THE Editor_Handoff SHALL default the Edit_Source to the set of generated clips rather than the single stitched final.mp4.
4. WHEN the edit request specifies the stitched final video as the source, THE Editor_Handoff SHALL upload the final.mp4 artifact as the single input for the edit job.
5. IF a requested source artifact does not exist, THEN THE Editor_Handoff SHALL reject the request with HTTP 400 and identify the missing artifact by its identifier.
6. IF the number of resolved input clips is less than 1 or greater than MAX_CLIPS_PER_JOB (500), THEN THE Editor_Handoff SHALL reject the request with HTTP 400 and report the allowed range of 1 to MAX_CLIPS_PER_JOB.
7. WHEN the input clip ordering is provided, THE Editor_Handoff SHALL send orden_clips to the Editor_Service in the exact order specified by the user.
8. WHEN the Editor_Service accepts the job with HTTP 202, THE Editor_Handoff SHALL store the returned editor job_id on the Edit_Job and set the Edit_Job status to running.

### Requirement 2: Configure editing options

**User Story:** As a generator user, I want to choose editing options before running the pipeline, so that the finished short matches my intent.

#### Acceptance Criteria

1. THE Editor_Handoff SHALL accept Edit_Options structured as enable/disable toggles for silence-cut and subtitles, an optional music selection, and a clip ordering selection.
2. WHEN a user provides an optional music track whose format is a supported audio type, THE Editor_Handoff SHALL write the music track to the Shared_Volume inputs prefix and reference the track in the request to the Editor_Service only after the write has succeeded.
3. WHEN no music track is provided by the user, THE Editor_Handoff SHALL omit the music reference from the request to the Editor_Service.
4. WHEN building the request to the Editor_Service, THE Editor_Handoff SHALL construct an Ajustes payload from the user-selected subset and fill remaining fields with Editor_Service defaults so that Editor_Service validation passes.
5. IF a user provides a music track whose format is not a supported audio type, THEN THE Editor_Handoff SHALL reject the request with HTTP 400, perform no upload, and return an error indicating the unsupported format.
6. IF the Editor_Service rejects the request with an invalid-request error, THEN THE Editor_Handoff SHALL set the Edit_Job status to failed, retain the submitted Edit_Options, and surface the Editor_Service error details identifying the rejected fields.

### Requirement 3: Manage the b-roll bank

**User Story:** As a generator user, I want a bank of reusable b-roll clips, so that I can reuse supplemental footage across multiple edits.

#### Acceptance Criteria

1. WHEN a user uploads a b-roll clip whose format and size are valid, THE Broll_Bank SHALL store the clip as a Broll_Clip and return a unique identifier for the stored clip.
2. WHEN a user requests the b-roll library, THE Broll_Bank SHALL return the list of stored Broll_Clips, each entry including its unique identifier and display metadata comprising at minimum the clip name, the clip duration in seconds, and the upload timestamp.
3. WHEN a user selects between 1 and MAX_CLIPS_PER_JOB Broll_Clips for an edit, THE Broll_Bank SHALL return one reference per selected clip that the Editor_Handoff can resolve into edit-job inputs.
4. IF a user uploads a file whose format is not a video container format supported by the Editor_Service pipeline, THEN THE Broll_Bank SHALL reject the upload with HTTP 400, store no Broll_Clip, and return an error indicating the unsupported format and the set of supported video formats.
5. IF a user uploads a b-roll file whose size is 0 bytes or exceeds the configured maximum b-roll clip size, THEN THE Broll_Bank SHALL reject the upload with HTTP 400, store no Broll_Clip, and return an error indicating the allowed file-size range.
6. IF a user selects a Broll_Clip identifier that does not exist in the Broll_Bank, THEN THE Editor_Handoff SHALL reject the edit request with HTTP 400 and identify the missing b-roll clip.

### Requirement 4: Insert b-roll clips into the edit ordering

**User Story:** As a generator user, I want to place selected b-roll clips into the clip ordering alongside my generated clips, so that the final edit combines both sources in the sequence I choose.

#### Acceptance Criteria

1. WHEN a user includes selected Broll_Clips in the clip ordering at a zero-based position index, THE Editor_Handoff SHALL resolve each Broll_Clip into an input and place that resolved input at the specified zero-based index within orden_clips relative to the generated clips.
2. WHEN an edit request combines generated clips and Broll_Clips, THE Editor_Handoff SHALL write all resolved inputs to the Shared_Volume inputs prefix and send orden_clips in the exact combined order specified by the user.
3. IF the combined count of generated clips and Broll_Clips is less than 1 or greater than MAX_CLIPS_PER_JOB (500), THEN THE Editor_Handoff SHALL reject the request with HTTP 400, report the allowed range of 1 to MAX_CLIPS_PER_JOB, and place no inputs.
4. IF any provided position index is outside the range of the combined ordering, THEN THE Editor_Handoff SHALL reject the request with HTTP 400, return an error indicating the invalid index, and place no inputs.
5. IF the provided position indexes are not unique and contiguous, THEN THE Editor_Handoff SHALL reject the request with HTTP 400, return an error indicating the invalid ordering, and place no inputs.

### Requirement 5: Track edit job progress

**User Story:** As a generator user, I want to watch the progress of my edit job, so that I know its current state and when the result is ready.

#### Acceptance Criteria

1. WHEN a user requests progress for an existing Edit_Job, THE Editor_Handoff SHALL query the Editor_Service `/progreso/{id}` endpoint and return, within 5 seconds, the normalized progress including porcentaje, paso_actual, mensaje, and error.
2. THE Editor_Handoff SHALL return progress porcentaje values within the range 0 to 100 inclusive.
3. WHEN successive progress values are returned for the same Edit_Job, THE Editor_Handoff SHALL return porcentaje values that are non-decreasing across the sequence.
4. WHILE the Edit_Job has no assigned editor job_id, THE Editor_Handoff SHALL report a porcentaje of 0 regardless of the Edit_Job status.
5. WHEN an editor job_id has been assigned to the Edit_Job, THE Editor_Handoff SHALL allow the reported porcentaje to increase beyond 0.
6. WHEN the Editor_Service reports estado COMPLETADO, THE Editor_Handoff SHALL set the Edit_Job status to completed.
7. WHEN the Editor_Service reports estado FALLIDO, THE Editor_Handoff SHALL set the Edit_Job status to failed and record the error paso and motivo.
8. WHEN the Editor_Service reports an estado that indicates the job is paused awaiting user confirmation, THE Editor_Handoff SHALL set the Edit_Job status to awaiting_edit.
9. WHEN a user confirms a paused manual edit step for an Edit_Job whose status is awaiting_edit, THE Editor_Handoff SHALL forward the confirmation to the Editor_Service resume endpoint and, upon acceptance, set the Edit_Job status to running.
10. IF a user requests progress for an Edit_Job identifier that does not exist, THEN THE Editor_Handoff SHALL reject the request with HTTP 404 and identify the missing Edit_Job identifier while making no change to any Edit_Job state.
11. IF the Editor_Service `/progreso/{id}` query fails with a network error, a 5xx response, or a timeout exceeding 5 seconds, THEN THE Editor_Handoff SHALL return the last successfully recorded progress for the Edit_Job, indicate that live progress is temporarily unavailable, and preserve the current Edit_Job status.
12. IF the Editor_Service rejects a paused-step resume confirmation, THEN THE Editor_Handoff SHALL keep the Edit_Job status at awaiting_edit and surface an error indicating the confirmation was not accepted.

### Requirement 6: Persist edited output for later retrieval

**User Story:** As a generator user, I want my edited videos saved to the project storage, so that I can download them later instead of only at the moment editing completes.

#### Acceptance Criteria

1. WHEN the Editor_Service completes an edit job, THE Storage_Backend SHALL persist the finished video to the Output_Store under the edit job outputs location and return the output key.
2. WHEN an edit job reaches completed status, THE Editor_Handoff SHALL record the output key on the Edit_Job so that the finished video is retrievable after completion.
3. WHEN a user requests the list of edited outputs for a project, THE Editor_Handoff SHALL return only the Edit_Jobs whose status is completed, each with its retrievable output key, ordered by completion time from most recent to oldest.
4. WHEN a user requests the list of edited outputs for a project that has no completed Edit_Jobs, THE Editor_Handoff SHALL return an empty list.
5. WHEN a user requests the result of a completed Edit_Job whose output object is present in the Output_Store, THE Editor_Handoff SHALL either stream the stored output typed as video/mp4 while honoring HTTP Range requests for partial content, or redirect to a signed URL that grants read access to the stored output and expires after a configured duration between 60 and 3600 seconds inclusive.
6. WHILE an Edit_Job status is completed, THE Output_Store SHALL retain the finished video until the configured lifecycle expiration elapses.
7. IF the configured output retention period is less than or equal to zero, THEN THE Output_Store SHALL treat the value as invalid and apply the configured minimum retention period, which SHALL be at least 1 second.
8. IF the Storage_Backend fails to persist the finished video to the Output_Store, THEN THE Editor_Handoff SHALL set the Edit_Job status to failed, omit any output key from the Edit_Job, and report an error indicating that the output could not be stored.
9. IF a user requests the result of an Edit_Job whose status is not completed, THEN THE Editor_Handoff SHALL reject the request, prevent any streaming or redirect to the output, and report that the output is not yet available.
10. IF the Edit_Job status is completed but the output object is absent from the Output_Store, THEN THE Editor_Handoff SHALL respond with HTTP 500 and mark the Edit_Job as needing a re-run.

### Requirement 7: Exchange files within the single service

**User Story:** As a system operator, I want inputs exchanged over an in-instance Shared_Volume and finished outputs persisted through the existing durable storage, so that the handoff avoids oversized in-request payloads and edited videos survive Cloud Run instance recycling.

#### Acceptance Criteria

1. WHERE Edit_Mode is cloud, THE Storage_Adapter SHALL write edit-job inputs to the Shared_Volume under the prefix edit-io/<editJobId>/inputs/.
2. WHERE Edit_Mode is cloud, THE Editor_Service SHALL read inputs from the Shared_Volume and write its working output under the prefix edit-io/<editJobId>/outputs/ on the Shared_Volume.
3. WHERE Edit_Mode is cloud, THE Storage_Backend SHALL persist the finished video to the existing Output_Store for later download.
4. WHERE Edit_Mode is cloud and a source artifact already resides in the existing Output_Store, THE Storage_Adapter SHALL materialize that artifact onto the Shared_Volume exactly once for the Editor_Service to consume.
5. WHEN the Editor_Service processes inputs referenced by Shared_Volume key, THE Storage_Backend SHALL materialize each input into the job workdir as a real local file path before the pipeline runs.
6. WHEN materializing inputs referenced by an ordered list, THE Storage_Backend SHALL preserve the order of the referenced inputs.
7. IF a referenced input is missing or unreadable during materialization, THEN THE Storage_Backend SHALL abort before the pipeline runs, create no partial local files, and report an error identifying the failing input.
8. WHEN the finished video has been persisted to the existing Output_Store, THE Storage_Adapter SHALL remove the per-job Shared_Volume scratch under edit-io/<editJobId>/.
9. WHILE a finished video is stored, THE Output_Store SHALL retain that video according to the existing Output_Store lifecycle policy configured for videogeneradorxd rather than a dedicated edit-only retention rule.

### Requirement 8: Reconcile job and progress models

**User Story:** As a generator developer, I want edit jobs tracked separately from generation jobs, so that their different lifecycles and progress semantics do not interfere.

#### Acceptance Criteria

1. WHEN an edit request is started, THE Generator SHALL create exactly one Edit_Job storing the editor job_id, as an entity separate from and not inserted into the generation JobRecord collection.
2. WHEN the Editor_Service reports an estado, THE Editor_Handoff SHALL map that estado to the corresponding normalized Edit_Job status of queued, running, awaiting_edit, completed, or failed.
3. THE Editor_Handoff SHALL assign porcentaje and step information from the Editor_Service progress response, and SHALL never decrease a previously reported porcentaje, which SHALL be an integer within the range 0 to 100 inclusive.
4. IF an Edit_Job fails, THEN THE Generator SHALL leave the PlanJSON, the manifest, and all generation JobRecords byte-for-byte unchanged and surface an error indication.
5. IF the Editor_Service returns an estado that does not map to any normalized status, THEN THE Editor_Handoff SHALL set the Edit_Job status to failed and record an error indicating the unrecognized estado.
6. IF the Editor_Service progress cannot be fetched, THEN THE Editor_Handoff SHALL retain the last known status and porcentaje and surface an error indication.

### Requirement 9: Isolate the editor behind the existing application auth

**User Story:** As a security engineer, I want the editor reachable only from the generator over localhost and fronted by the generator's existing authentication, so that the editing pipeline is never exposed publicly and no parallel auth mechanism is introduced.

#### Acceptance Criteria

1. WHERE Edit_Mode is cloud, THE Editor_Service SHALL be reachable only from the Generator container over `http://127.0.0.1:<editor-port>` and SHALL NOT be exposed to external ingress.
2. THE Generator SHALL make the Editor_Service reachable from the browser only via the proxied `/api/edit/*` endpoints and never directly.
3. THE Generator SHALL protect all `/api/edit/*` endpoints with videogeneradorxd's existing application authentication.
4. WHERE Edit_Mode is cloud, THE Storage_Adapter SHALL be confined to reading and writing only under the edit-io/<editJobId>/ prefixes on the Shared_Volume and to the edit-output location within the existing Output_Store, and THE Storage_Backend SHALL be confined to reading inputs under edit-io/<editJobId>/inputs/ and writing outputs under edit-io/<editJobId>/outputs/ on the Shared_Volume plus persisting to the edit-output location within the existing Output_Store.
5. IF a Storage_Adapter or Storage_Backend access violates its permitted prefix scope, THEN the access SHALL be rejected, no data SHALL be read or written, and an error SHALL be returned.
6. WHEN deriving Shared_Volume keys for an edit job, THE Editor_Handoff SHALL confine all derived keys to the edit-io/<editJobId>/ prefix and SHALL reject any key that would traverse outside that prefix, accessing no storage and aborting the job with an error.

### Requirement 10: Preserve standalone operation of both applications

**User Story:** As a developer, I want both applications to run standalone in local mode, so that neither requires cloud services for local development.

#### Acceptance Criteria

1. WHERE Edit_Mode is local, THE Generator SHALL reach the Editor_Service over the configured loopback address (e.g. 127.0.0.1) and SHALL perform zero GCS network calls.
2. WHERE the Storage_Backend is configured as local, THE Editor_Service SHALL read every input and write every output exclusively via on-disk filesystem paths, performing zero cloud-storage network calls.
3. WHERE Edit_Mode is local, THE Editor_Service SHALL, given identical inputs and identical Ajustes, produce output files that are byte-for-byte identical to those produced by the pre-integration pipeline.
4. WHERE the Storage_Adapter or Storage_Backend is configured as local, THE round trip of placing an input and reading it back SHALL return output that is byte-for-byte identical to the original input (identical length and identical byte sequence).
5. WHEN the `/salud` health endpoint is called, THE Editor_Service SHALL return a success response only after startup dependency verification has confirmed that all four dependencies (ffmpeg, ffprobe, auto-editor, faster-whisper) are present and invokable.
6. IF any of the four dependencies (ffmpeg, ffprobe, auto-editor, faster-whisper) is missing or not invokable at startup, THEN THE Editor_Service SHALL fail startup dependency verification and return a non-success response from the `/salud` endpoint with an error indication identifying the missing dependency.

### Requirement 11: Handle edit-job errors

**User Story:** As a generator user, I want clear and recoverable errors when an edit job fails, so that I can correct the issue and retry.

#### Acceptance Criteria

1. IF an input write to the Shared_Volume fails, THEN THE Editor_Handoff SHALL set the Edit_Job status to failed, record an error message that identifies the failed input and the failure cause, and leave any already-written inputs for the job unchanged.
2. WHEN a transient network error, 5xx response, or request timeout exceeding 60 seconds occurs while calling the Editor_Service, THE Editor_Handoff SHALL retry the call up to a maximum of 5 attempts using exponential backoff with an initial delay of 1 second, doubling each attempt, and capped at 30 seconds per delay.
3. IF all retry attempts to the Editor_Service are exhausted without a successful response, THEN THE Editor_Handoff SHALL set the Edit_Job status to failed, record an error message indicating the Editor_Service was unreachable, and preserve the last successfully persisted Edit_Job state.
4. WHEN an Editor_Service step fails with a paso and motivo, THE Editor_Handoff SHALL set the Edit_Job status to failed and return the paso and motivo in the progress response so the user can identify the failing step and its cause.
5. WHERE a failsoft flag is enabled for an optional step, THE Editor_Service SHALL continue the pipeline without the failing optional step and complete the job instead of failing the whole job.
6. IF persisting an Edit_Job status update fails, THEN THE Generator SHALL retry the persistence up to a maximum of 5 attempts using exponential backoff with an initial delay of 1 second, doubling each attempt, and capped at 30 seconds per delay, and SHALL preserve the last successfully persisted Edit_Job state until an update succeeds.
