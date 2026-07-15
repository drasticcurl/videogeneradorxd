# Design Document: video-editor-integration

## Overview

Today the **generator** (`videogeneradorxd`, Next.js 14 + TypeScript, being migrated to Cloud Run) produces images and videos with Vertex AI (Gemini / Nano Banana / Veo), stitches clips into `final.mp4` with ffmpeg, and stores everything under `./output/<project_id>/`. Separately, the **editor** (`ksaljdlkasjdklasd`, Next.js frontend + FastAPI backend, 100% local, no auth) turns raw vertical clips into a finished 9:16 short via a strict 5-step pipeline (UNIR → CORTAR SILENCIOS → TRANSCRIBIR → SUBTÍTULOS → MÚSICA), driven by faster-whisper + ffmpeg + auto-editor.

This feature merges the two so that a user, **inside the generator UI**, can hand off a generated `final.mp4` (or a selection of individual clips) into the editing pipeline, configure editing options (silence cut, subtitles, music, ordering), run the job, watch progress, preview, and download the edited short — **without leaving the generator app**. The generator becomes "generate **and** edit".

The central engineering constraint is that the two systems have **incompatible runtimes**: the generator is Node/TypeScript, the editor is Python with heavy native/CPU dependencies (`faster-whisper`, `ffmpeg` + `libass`, `auto-editor`). The chosen approach brings the editor's Python/FastAPI code **into the `videogeneradorxd` repository** (e.g., under a `backend/` or `editor/` subdirectory) and deploys it as part of **one Cloud Run service** on the `feat/gcloud-migration` branch: a **single multi-container Cloud Run service** where the Next.js generator container is the ingress and the Python/FastAPI editor runs as a **sidecar container**, the two communicating over **localhost** within the same instance. The design keeps the editor's Python engine intact (it is battle-tested, with a comprehensive pytest + hypothesis suite) and only abstracts its I/O boundaries. Files are exchanged between the two containers over a **shared volume** (localhost / in-instance scratch), while durable "download later" outputs are persisted through the **GCS bucket/storage layer that videogeneradorxd already implements** on `feat/gcloud-migration`. Both apps continue to work standalone (local-first fallbacks preserved).

## Goals and Non-Goals

**Goals**
- One-click handoff from generator (final video or selected clips) into the editor pipeline.
- Configure editor options, launch, track progress, preview, and download from the generator UI.
- Run on Cloud Run as a single multi-container service (generator + editor sidecar) despite the two different runtimes.
- Reuse videogeneradorxd's existing auth (single front-door) and existing GCS storage layer rather than introducing parallel mechanisms.
- Preserve standalone operation of both apps (local filesystem, no external services required in local mode).
- Reuse the editor's proven 5-step engine and its existing HTTP contract (`/procesar`, `/progreso/{id}`, `/descargar/{id}`) with minimal changes.

**Non-Goals**
- Rewriting the editor engine in TypeScript.
- Changing the generator's PlanJSON schema or its Vertex generation pipeline.
- Real-time collaborative editing or multi-tenant accounts (out of scope for this feature).
- Replacing the generator's own optional `final.mp4` stitch (the editor's UNIR step supersedes it for the edit path, but the local stitch stays).

## Architecture

### Option analysis (with tradeoffs) and recommendation

| Option | Description | Pros | Cons |
|---|---|---|---|
| **(a) Single multi-container Cloud Run service — editor as a sidecar** (CHOSEN) | Bring the FastAPI editor code into the `videogeneradorxd` repo and deploy it as a **sidecar container** alongside the Next.js generator container in **one** Cloud Run service. The generator (ingress) proxies to the editor over `http://127.0.0.1:<editor-port>`. Inputs move over a shared in-instance volume; durable outputs use videogeneradorxd's existing GCS storage. | One repo, one deploy, one Cloud Run service → simplest ops; localhost networking between containers (no cross-service auth, no public editor endpoint); shared instance volume acts as scratch space so inputs need not round-trip through GCS; reuses videogeneradorxd's existing auth and existing storage layer; zero rewrite of the proven Python engine + its PBT suite; both apps stay standalone. | Both containers share the instance lifecycle and scaling knobs; the editor is CPU-heavy (whisper/ffmpeg) so the shared instance must be sized generously; editor cannot scale independently of the generator. |
| **(b) Editor as a separate Cloud Run service** | Containerize the FastAPI editor as its own Cloud Run service; the generator calls it over authenticated HTTP; files exchanged via a GCS bucket. | Independent scaling; clean runtime isolation. | Two repos/services to deploy and operate; cross-service auth (OIDC) and networking needed; every file must round-trip through GCS; more moving parts. Rejected by the user in favor of a single service. |
| **(c) Reimplement editor steps as Next.js routes / child processes** | Port UNIR/silences/transcribe/subtitles/music into the Node app, shelling out to ffmpeg and a whisper binary. | Single language/runtime. | Massive rewrite; loses the Python engine's hypothesis/pytest guarantees; `faster-whisper` has no first-class Node equivalent; Node container must bundle ffmpeg+libass+whisper models → large image, long cold starts; high risk. Rejected. |

**Decision: Option (a) — a single multi-container Cloud Run service with the editor as a sidecar.** The user chose this so there is **one repository, one deploy, and one Cloud Run service** to reason about and operate. Because both containers live in the same instance, they talk over **localhost** (no cross-service auth, no publicly exposed editor), inputs can travel over a **shared volume** instead of round-tripping through object storage, and the integration **reuses videogeneradorxd's existing auth and existing GCS storage** rather than standing up parallel mechanisms. The honest tradeoff is that the generator and editor now **share the instance lifecycle and scaling knobs**: the editor remains CPU-heavy for `faster-whisper` transcription and `ffmpeg`/`auto-editor` rendering, so the shared instance must be **sized for the editor's peak** (generous CPU/RAM, long request timeout) even when only the generator is active, and the editor cannot scale independently. Option (b) was rejected to avoid two-service operational overhead and cross-service auth; Option (c) was rejected due to cost/risk of rewriting the engine.

## Correctness Properties

1. **Order preservation**: For any handoff with `source=clips` and ordering `O`, the sequence of `orden_clips` sent to the editor equals `O`, and the editor materializes/concatenates in that exact order.
2. **Progress monotonicity end-to-end**: For any `editJobId`, successive values returned by `/api/edit/:id/progress` have non-decreasing `porcentaje ∈ [0,100]`.
3. **Terminal consistency**: `status="completed"` ⇒ `outputKey` object exists and is a playable MP4; `status="failed"` ⇒ `error={paso,motivo}` is present and no partial artifact is advertised as the result.
4. **Standalone invariance**: With `EDIT_MODE=local` / `VSE_STORAGE_BACKEND=local`, both apps behave byte-for-byte as before this feature.
5. **Isolation of failures**: A failed `EditJob` never mutates the generator PlanJSON/manifest or any generation `JobRecord`.
6. **Least-privilege I/O**: Per-job keys are confined to the `edit-io/<editJobId>/` prefix on the shared volume and under the existing storage's edit-output location — no other paths are reachable.
7. **Editor isolation (no public endpoint)**: The editor sidecar is reachable only over `http://127.0.0.1:<editor-port>` from within the same instance; it is never exposed to ingress. The generator's existing application auth is the only front door.
