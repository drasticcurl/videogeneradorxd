/**
 * Edit domain types for the generator ↔ editor integration.
 *
 * These mirror the editor's FastAPI models but use TypeScript-native constructs
 * and Zod schemas. They are the generator's authoritative representation of an
 * edit job, its sources, options, and progress — independent of the editor's
 * internal Python models.
 *
 * Requirements: 1, 2, 8
 */

// ---------------------------------------------------------------------------
// EditSource — describes what inputs feed an edit job
// ---------------------------------------------------------------------------

/**
 * Discriminated union for edit input selection.
 * - "clips": ordered set of individual generated clips (default).
 * - "final": the single stitched final.mp4.
 */
export type EditSource =
  | { type: "clips"; clipIds: string[] }
  | { type: "final"; artifactKey: string };

// ---------------------------------------------------------------------------
// EditJobStatus — normalized lifecycle states
// ---------------------------------------------------------------------------

/**
 * Normalized edit job status (mirrors the editor's estados but in a
 * generator-friendly vocabulary).
 *
 * Lifecycle:
 *   queued → uploading → running → (awaiting_edit ⇄ running) → completed | failed
 */
export type EditJobStatus =
  | "queued"
  | "uploading"
  | "running"
  | "awaiting_edit"
  | "completed"
  | "failed";

// ---------------------------------------------------------------------------
// EditOptions — user-configurable editing settings
// ---------------------------------------------------------------------------

/**
 * Clip ordering entry: zero-based index + clip identifier.
 */
export interface ClipOrderEntry {
  /** Zero-based position in the final ordering. */
  index: number;
  /** Clip identifier (generated clip id or broll clip id). */
  clipId: string;
  /** Whether this entry is a b-roll clip. */
  isBroll: boolean;
}

/**
 * User-configurable editing options for a job.
 */
export interface EditOptions {
  /** Enable silence-cut step (CORTAR_SILENCIOS). */
  silenceCut: boolean;
  /** Enable subtitle generation (TRANSCRIBIR + SUBTÍTULOS). */
  subtitles: boolean;
  /** Optional music track identifier (from uploaded bank or new upload). */
  musicTrackId?: string;
  /** Explicit clip ordering. If omitted, clips are used in their natural order. */
  ordering?: ClipOrderEntry[];
}

// ---------------------------------------------------------------------------
// EditJob — the generator-owned entity wrapping an editor job
// ---------------------------------------------------------------------------

/**
 * Error info when an edit job fails.
 */
export interface EditJobError {
  /** Pipeline step that failed (e.g. "UNIR", "TRANSCRIBIR"). */
  paso: string;
  /** Human-readable reason for the failure. */
  motivo: string;
}

/**
 * The generator-owned EditJob entity.
 * Wraps exactly one Editor_Service job and mirrors normalized status + progress.
 */
export interface EditJob {
  /** Unique edit-job identifier (generator side). */
  id: string;
  /** Project this edit job belongs to. */
  projectId: string;
  /** The source selection that produced this job. */
  source: EditSource;
  /** The user-selected editing options. */
  options: EditOptions;
  /** Current normalized status. */
  status: EditJobStatus;
  /** Editor-side job_id. null only in queued/uploading/pre-accept-failed states. */
  editorJobId: string | null;
  /** Progress information. */
  progress: EditorProgress;
  /** GCS / local output key once completed. */
  outputKey: string | null;
  /** Error details (only when status=failed). */
  error: EditJobError | null;
  /** ISO timestamp when the job was created. */
  createdAt: string;
  /** ISO timestamp of last status update. */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// EditorProcesarRequest — payload sent to the editor's /procesar endpoint
// ---------------------------------------------------------------------------

/**
 * The payload shape sent to the editor's POST /procesar endpoint.
 * Matches the editor's ProcesarRequest Pydantic model.
 */
export interface EditorProcesarRequest {
  /** Generator edit job namespace used for shared filesystem materialization. */
  edit_job_id?: string;
  /** Ordered relative filenames under edit-io/<edit_job_id>/inputs. */
  orden_clips: string[];
  /** Optional music track identifier/path. */
  musica_id?: string;
  /** Editor settings (Ajustes). Partial subset filled with defaults. */
  ajustes: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// EditorProgress — normalized progress from the editor's /progreso/{id}
// ---------------------------------------------------------------------------

/**
 * Normalized progress as returned by the generator's BFF progress endpoint.
 */
export interface EditorProgress {
  /** Percentage complete: integer in [0, 100], non-decreasing. */
  porcentaje: number;
  /** Current pipeline step name (e.g. "UNIR", "CORTAR_SILENCIOS"). */
  pasoActual: string | null;
  /** Human-readable message about current progress. */
  mensaje: string;
  /** Error details when failed. */
  error: EditJobError | null;
}
