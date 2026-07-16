# Requirements Document

## Introduction

The generator's "Enviar al editor" flow currently treats the editor as a fully automatic pipeline: it starts a job, polls progress, and shows a progress bar until a durable result appears. In reality the editor is an interactive shorts editor with three mandatory human-in-the-loop pauses. When the editor pauses, it reports one of three Spanish `estado` values (`esperando_edicion_silencios`, `esperando_revision`, `esperando_edicion_final`). Today the generator collapses all three into a single `awaiting_edit` status and shows a static message with no controls, so the integration hangs at the first pause with no way for the user to act.

This feature makes the editor's three mandatory interactive pauses first-class in the generator UI. It splits the collapsed `awaiting_edit` status into three explicit, actionable generator statuses (`awaiting_silences`, `awaiting_subtitles`, `awaiting_final_render`); adds BFF pass-through routes that fetch each pause's payload from the editor and forward the user's edited confirmations to the editor's existing resume endpoints; adds three edit surfaces (silence-editing timeline, subtitle-review editor, final-render trigger); and serves the editor's intermediate videos for in-browser preview via a Range-aware BFF proxy of the editor `/workfile` endpoint.

The feature is additive and non-breaking: the editor Python service is unchanged; automatic behavior is preserved when a pause does not apply; and the existing `EditJob` entity plus the `/start`, `/progress`, `/result`, and `/api/edit` list contracts are preserved.

## Glossary

- **Editor**: The FastAPI interactive shorts-editor service bound to `127.0.0.1:8000`. It is loopback-internal and not reachable by the browser.
- **BFF**: The Next.js ingress layer (`/api/edit/*`) that is the only browser-facing surface; it forwards browser requests to the Editor over loopback.
- **Browser_UI**: The browser-side generator UI, including `EditProgress` and the three edit components.
- **Status_Mapper**: The generator function (`mapEditorEstado`) that maps each editor `estado` to exactly one generator status.
- **Job_Reconciler**: The generator component that polls editor progress, applies percent monotonicity, and reconciles job status.
- **Edit_Job**: The generator-side job entity keyed by `editJobId`, holding `status`, `progress`, and `editorJobId`.
- **Editor_Job_Id**: The editor's `job_id`, stored on the Edit_Job as `editorJobId`, mapping the generator job to the editor job.
- **Generator_Status**: One of the eight statuses `queued`, `uploading`, `running`, `awaiting_silences`, `awaiting_subtitles`, `awaiting_final_render`, `completed`, `failed`.
- **Editor_Estado**: The editor's Spanish status value (`en_cola`, `en_ejecucion`, `esperando_edicion_silencios`, `esperando_revision`, `esperando_edicion_final`, `completado`, `fallido`).
- **Awaiting_Status**: Any of the three actionable pause statuses `awaiting_silences`, `awaiting_subtitles`, `awaiting_final_render`.
- **Silence_Segment**: A cut range `{inicioS, finS}` (editor form `{inicio_s, fin_s}`) describing a portion of the joined video to remove.
- **Subtitle_Group**: A proposed subtitle line with `texto` plus read-only group and per-word timings.
- **Extra_Text**: An optional "hook" text overlaid on the final render, with text, timing, and style.
- **Preview_Proxy**: The BFF route `/api/edit/[editJobId]/preview/[name]` that proxies the editor `/workfile/{job_id}/{name}` endpoint.
- **Intermediate_Video**: An editor work file eligible for preview; the allowlist is `unido.mp4` (joined) and `cortado.mp4` (cut).
- **Durable_Output**: The persisted final result (`final.mp4`) detected output-first, independent of the editor's in-memory job.
- **Recoverable_Error**: An actionable failure state produced when the editor's in-memory job is lost, offering the user a clear next action rather than a silent hang.

## Requirements

### Requirement 1: Edit detected silence segments and confirm to continue

**User Story:** As a generator user, I want to review and edit the detected silence cut segments on the joined video and confirm them, so that the editor resumes the pipeline with my chosen cuts.

#### Acceptance Criteria

1. WHEN the Editor reports `estado` `esperando_edicion_silencios`, THE Status_Mapper SHALL map the Edit_Job to Generator_Status `awaiting_silences`.
2. WHILE the Edit_Job is in Generator_Status `awaiting_silences`, THE Browser_UI SHALL present a silence-editing surface that displays the joined-video preview and the detected Silence_Segment list.
3. WHEN the Browser_UI requests the silence pause payload, THE BFF SHALL return the editable flag, a preview reference, the joined-video duration, frame rate, width, height, and the detected Silence_Segment list.
4. WHEN the user confirms an edited Silence_Segment list while the Edit_Job is in Generator_Status `awaiting_silences`, THE BFF SHALL forward the segments to the editor `/silencios/{editorJobId}` resume endpoint mapped one-to-one to `{inicio_s, fin_s}` preserving order and values.
5. WHEN the Editor accepts the silence confirmation with a 202 response, THE BFF SHALL transition the Edit_Job to Generator_Status `running` and return status `running` to the Browser_UI.
6. IF a silence confirmation is submitted while the Edit_Job is not in Generator_Status `awaiting_silences`, THEN THE BFF SHALL reject the request with a 409 response and leave the Generator_Status unchanged.

### Requirement 2: Review and edit proposed subtitle groups and confirm

**User Story:** As a generator user, I want to review and edit the text of the proposed subtitle groups and confirm them, so that the editor resumes with corrected subtitle text while preserving timings.

#### Acceptance Criteria

1. WHEN the Editor reports `estado` `esperando_revision`, THE Status_Mapper SHALL map the Edit_Job to Generator_Status `awaiting_subtitles`.
2. WHILE the Edit_Job is in Generator_Status `awaiting_subtitles`, THE Browser_UI SHALL present one editable text field per proposed Subtitle_Group with the group and per-word timings shown as read-only.
3. WHEN the Browser_UI requests the subtitle pause payload, THE BFF SHALL return the editable flag and the proposed Subtitle_Group list.
4. WHEN the user confirms edited Subtitle_Group text while the Edit_Job is in Generator_Status `awaiting_subtitles`, THE BFF SHALL forward text-only groups to the editor `/subtitulos/{editorJobId}` resume endpoint without sending any timings.
5. WHEN the Editor accepts the subtitle confirmation with a 202 response, THE BFF SHALL transition the Edit_Job to Generator_Status `running` and return status `running` to the Browser_UI.
6. IF the submitted Subtitle_Group count differs from the proposed group count, THEN THE Editor SHALL reject the confirmation and THE BFF SHALL return a 400 response leaving the Generator_Status unchanged.

### Requirement 3: Trigger the final render with optional hook texts and download the result

**User Story:** As a generator user, I want to trigger the final Remotion render with up to two optional extra hook texts and then download the durable result, so that I can produce and retrieve the finished short.

#### Acceptance Criteria

1. WHEN the Editor reports `estado` `esperando_edicion_final`, THE Status_Mapper SHALL map the Edit_Job to Generator_Status `awaiting_final_render`.
2. WHILE the Edit_Job is in Generator_Status `awaiting_final_render`, THE Browser_UI SHALL present a final-render surface that shows the cut-video preview and the final Subtitle_Group list and allows adding up to two Extra_Text entries.
3. WHEN the Browser_UI requests the final-render pause payload, THE BFF SHALL return the editable flag, a preview reference, the final Subtitle_Group list, and the existing Extra_Text entries.
4. WHEN the user triggers the render while the Edit_Job is in Generator_Status `awaiting_final_render`, THE BFF SHALL forward the Extra_Text entries with engine `remotion` to the editor `/render/{editorJobId}` resume endpoint.
5. WHEN the Editor accepts the render trigger with a 202 response, THE BFF SHALL transition the Edit_Job to Generator_Status `running` and return status `running` to the Browser_UI.
6. WHEN the Edit_Job reaches Generator_Status `completed`, THE Browser_UI SHALL present a download link for the Durable_Output.

### Requirement 4: Preview intermediate videos in-browser via the BFF proxy

**User Story:** As a generator user, I want to preview the joined and cut intermediate videos in my browser, so that I can make informed edits during the silence and final-render pauses.

#### Acceptance Criteria

1. WHEN the Browser_UI requests a preview for an allowlisted Intermediate_Video name, THE Preview_Proxy SHALL proxy the editor `GET /workfile/{editorJobId}/{name}` endpoint and return `video/mp4` content.
2. WHEN a preview request includes a `Range` header, THE Preview_Proxy SHALL forward the `Range` header to the editor and return the editor status (200 or 206) with the `Content-Type`, `Content-Length`, `Content-Range`, and `Accept-Ranges` headers preserved.
3. THE BFF SHALL expose intermediate videos to the Browser_UI only through the Preview_Proxy and SHALL rewrite the editor-internal `video_url` to a Preview_Proxy reference.
4. IF the editor `/workfile` request returns 404, THEN THE Preview_Proxy SHALL return a 404 response and THE Browser_UI SHALL keep the edit controls usable.
5. THE Preview_Proxy SHALL set `Cache-Control` to `no-store` on preview responses.

### Requirement 5: Three distinct actionable statuses replacing the collapsed awaiting_edit

**User Story:** As a generator user, I want each editor pause represented by a distinct actionable status, so that the UI always shows the right control for the current pause instead of a static message.

#### Acceptance Criteria

1. THE Status_Mapper SHALL map every Editor_Estado to exactly one Generator_Status: `en_cola` to `queued`, `en_ejecucion` to `running`, `esperando_edicion_silencios` to `awaiting_silences`, `esperando_revision` to `awaiting_subtitles`, `esperando_edicion_final` to `awaiting_final_render`, `completado` to `completed`, and `fallido` to `failed`.
2. WHEN the Status_Mapper receives an Editor_Estado that matches after trimming and case-insensitive comparison, THE Status_Mapper SHALL map it deterministically to the corresponding Generator_Status.
3. IF the Status_Mapper receives an unknown Editor_Estado, THEN THE Status_Mapper SHALL map the Edit_Job to Generator_Status `failed` with a non-null error carrying `{paso: "STATUS_MAPPING", motivo}`.
4. THE Generator_Status domain SHALL consist of exactly the eight values `queued`, `uploading`, `running`, `awaiting_silences`, `awaiting_subtitles`, `awaiting_final_render`, `completed`, `failed`, and SHALL NOT include `awaiting_edit`.
5. WHILE the Edit_Job is in any Awaiting_Status, THE Browser_UI SHALL mount the interactive control corresponding to that status.

### Requirement 6: Recoverable-error behavior when the editor in-memory job is lost

**User Story:** As a generator user, I want a clear actionable message when the editor loses its in-memory job on a container restart, so that I am never left with a silently hanging job.

#### Acceptance Criteria

1. IF the editor returns 404 for an Edit_Job the generator believes is paused or running, THEN THE Job_Reconciler SHALL perform an output-first Durable_Output re-check before failing the Edit_Job.
2. WHEN the recoverable-error path re-check finds a Durable_Output, THE BFF SHALL transition the Edit_Job to Generator_Status `completed` and return a 200 response.
3. IF the recoverable-error path re-check finds no Durable_Output for a paused Edit_Job, THEN THE BFF SHALL transition the Edit_Job to Generator_Status `failed` with `{paso: "EDITOR_STATE_LOST", motivo}` and return a 409 response.
4. WHEN a lost paused Edit_Job is failed via the recoverable-error path, THE Browser_UI SHALL present the actionable reason and offer to send the job to the editor again.
5. THE BFF SHALL NOT leave an Edit_Job in an Awaiting_Status or `running` status without either advancing it or returning an actionable error.

### Requirement 7: Preserve automatic behavior and existing contracts

**User Story:** As a generator user, I want automatic editing to keep working unchanged when a pause does not apply, so that adding manual pauses does not regress the existing flow.

#### Acceptance Criteria

1. WHERE silences are disabled for an Edit_Job, THE Editor SHALL NOT enter `esperando_edicion_silencios` and THE Browser_UI SHALL keep polling without entering Generator_Status `awaiting_silences`.
2. WHERE no subtitle-review flag is set for an Edit_Job, THE Editor SHALL NOT enter `esperando_revision` and THE Browser_UI SHALL keep polling without entering Generator_Status `awaiting_subtitles`.
3. WHILE no applicable pause is reached, THE Browser_UI SHALL progress the Edit_Job from `running` through to `completed` using the existing 2-second poll loop.
4. THE BFF SHALL preserve the existing `/start`, `/progress`, `/result`, and `/api/edit` list route contracts.
5. THE Editor service, including its endpoints, states, and behavior, SHALL remain unchanged by this feature.

### Requirement 8: Validation rules for confirmations and previews

**User Story:** As a generator user, I want my edits validated before they reach the editor, so that malformed input fails fast with a clear message and cannot corrupt editor state.

#### Acceptance Criteria

1. WHEN a Silence_Segment list is submitted, THE BFF SHALL accept it only if the segments are sorted ascending by `inicioS`, pairwise non-overlapping, and every segment satisfies `0 <= inicioS < finS <= durationS` with finite numeric bounds.
2. IF a submitted Silence_Segment list violates the sorting, non-overlap, bounds, or numeric rules, THEN THE BFF SHALL reject it with a 400 response including per-segment details and leave the Generator_Status unchanged.
3. IF any submitted Subtitle_Group text is empty after trimming, THEN THE BFF SHALL reject the confirmation with a 400 response and leave the Generator_Status unchanged.
4. IF more than two Extra_Text entries are submitted to the render route, THEN THE BFF SHALL reject the request with a 400 response and leave the Generator_Status unchanged.
5. WHERE the render engine value is present in a render trigger, THE BFF SHALL require it to equal exactly `remotion`.
6. IF a preview request specifies a name that is not in the Intermediate_Video allowlist or contains a path separator or `..`, THEN THE Preview_Proxy SHALL reject it with a 400 response.

### Requirement 9: Percent monotonicity across pauses

**User Story:** As a generator user, I want the reported progress percentage to never move backward across pauses, so that the progress indicator remains trustworthy.

#### Acceptance Criteria

1. WHEN the Job_Reconciler persists progress, THE Job_Reconciler SHALL keep `progress.porcentaje` non-decreasing across successive reconciliations.
2. THE Job_Reconciler SHALL clamp `progress.porcentaje` to the range `[0, 100]`.
3. WHILE an Edit_Job transitions through a pause and resumes, THE Job_Reconciler SHALL preserve percent monotonicity across the pause-to-resume transition.

### Requirement 10: No silent hang across all statuses

**User Story:** As a generator user, I want every reachable job status to yield a control or an actionable message, so that the integration never leaves me stuck without feedback.

#### Acceptance Criteria

1. WHILE the Edit_Job is in Generator_Status `queued`, `uploading`, or `running`, THE Browser_UI SHALL render a live progress bar.
2. WHILE the Edit_Job is in any Awaiting_Status, THE Browser_UI SHALL render the corresponding interactive control.
3. WHEN the Edit_Job is in Generator_Status `completed`, THE Browser_UI SHALL render a download link.
4. WHEN the Edit_Job is in Generator_Status `failed`, THE Browser_UI SHALL render an error message carrying the `{paso, motivo}` reason.
5. WHEN an editor 404 is encountered while an Edit_Job is paused or running, THE BFF SHALL resolve the Edit_Job to `completed` or `failed` with an actionable reason rather than an indefinite awaiting or running state.
