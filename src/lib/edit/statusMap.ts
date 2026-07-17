/**
 * Editor estado → normalized EditJobStatus mapping and validation.
 *
 * The editor's FastAPI backend reports progress with a Spanish-language `estado`
 * field (EN_COLA, EN_EJECUCION, ESPERANDO_EDICION_SILENCIOS, etc.). This module
 * maps those to the generator's normalized EditJobStatus vocabulary.
 *
 * Requirements: 4, 8
 */

import { z } from "zod";
import { getMaxClipsPerJob } from "./config";
import type { EditJobStatus, ClipOrderEntry } from "./types";

// ---------------------------------------------------------------------------
// Estado → Status mapping
// ---------------------------------------------------------------------------

/** Known editor estados (from editor's JobStatus enum values). */
const ESTADO_MAP: Record<string, EditJobStatus> = {
  en_cola: "queued",
  en_ejecucion: "running",
  esperando_edicion_silencios: "awaiting_silences",
  esperando_revision: "awaiting_subtitles",
  esperando_edicion_final: "awaiting_final_render",
  completado: "completed",
  fallido: "failed",
};

export interface MapEditorEstadoResult {
  status: EditJobStatus;
  /** Non-null only when the estado was unrecognized → forced to failed. */
  error: { paso: string; motivo: string } | null;
}

// ---------------------------------------------------------------------------
// End-to-end correlation tuple (spec `unir-step-hang`, Task 3.4)
//
// Every relevant progress event/log carries this correlation so a job at the
// opaque 25% boundary is observable and classifiable end-to-end (design
// "Correlation tuple", Req 2.5). It is state metadata only — NEVER video
// content, and NEVER the numeric percentage used as state. All fields are
// optional so the tuple degrades cleanly when a value is unknown (e.g. no
// editorJobId yet, or version/revision not baked in a local build).
// ---------------------------------------------------------------------------

/** Identifiers that tie a progress observation to a concrete build/revision/job pair. */
export interface EditCorrelation {
  /** Build/display version identifier (getAppVersion().version). */
  version?: string;
  /** Cloud Run revision name (K_REVISION), server-side diagnostics only. */
  revision?: string;
  /** Generator-side edit job id. */
  editJobId?: string;
  /** Editor-side (FastAPI) job id, when assigned. */
  editorJobId?: string;
}

/**
 * Builds the correlation tuple from the pieces available during reconciliation.
 * Only truthy fields are included so the result is byte-for-byte minimal and a
 * missing editorJobId/version/revision simply omits that key.
 */
export function buildCorrelation(params: {
  editJobId: string;
  editorJobId?: string | null;
  version?: string | null;
  revision?: string | null;
}): EditCorrelation {
  const correlation: EditCorrelation = { editJobId: params.editJobId };
  if (params.editorJobId) correlation.editorJobId = params.editorJobId;
  if (params.version) correlation.version = params.version;
  if (params.revision) correlation.revision = params.revision;
  return correlation;
}

// ---------------------------------------------------------------------------
// Differentiated reconciliation events (spec `unir-step-hang`, Task 3.5)
//
// Each reconcile tick maps the resulting job status (+ any terminal error) to a
// DISTINGUISHABLE, structured event kind, so the last confirmed reconciliation
// event localizes a stall into exactly one of the design's categories A/B/C/D:
// a reached-but-un-propagated pause surfaces as `reconcile_awaiting_silences`
// (category C) and a lost editor job as `editor_state_lost` (category C via the
// EDITOR_STATE_LOST path). It carries no video content — only the event kind.
// ---------------------------------------------------------------------------

/** Structured reconcile event kinds (mirrors the Python `evento_tipo`). */
export type ReconcileEventType =
  | "reconcile_awaiting_silences"
  | "reconcile_awaiting_subtitles"
  | "reconcile_awaiting_final_render"
  | "reconcile_completed"
  | "editor_state_lost"
  | "status_mapping_failed"
  | "reconcile_failed"
  | "reconcile_progress";

/**
 * Maps a reconciled job status (and any terminal error) to a differentiated
 * reconcile event kind. Pure and total: every status yields exactly one kind.
 */
export function reconcileEventForStatus(
  status: EditJobStatus,
  error?: { paso?: string; motivo?: string } | null,
): ReconcileEventType {
  switch (status) {
    case "awaiting_silences":
      return "reconcile_awaiting_silences";
    case "awaiting_subtitles":
      return "reconcile_awaiting_subtitles";
    case "awaiting_final_render":
      return "reconcile_awaiting_final_render";
    case "completed":
      return "reconcile_completed";
    case "failed":
      if (error?.paso === "EDITOR_STATE_LOST") return "editor_state_lost";
      if (error?.paso === "STATUS_MAPPING") return "status_mapping_failed";
      return "reconcile_failed";
    default:
      return "reconcile_progress";
  }
}

/**
 * Maps an editor estado string to the normalized EditJobStatus.
 *
 * - EN_COLA → queued
 * - EN_EJECUCION → running
 * - ESPERANDO_EDICION_SILENCIOS → awaiting_silences
 * - ESPERANDO_REVISION → awaiting_subtitles
 * - ESPERANDO_EDICION_FINAL → awaiting_final_render
 * - COMPLETADO → completed
 * - FALLIDO → failed
 * - Unrecognized → failed with error {paso:"STATUS_MAPPING", motivo}
 *
 * The comparison is case-insensitive and trimmed.
 */
export function mapEditorEstado(estado: string): MapEditorEstadoResult {
  const normalized = estado.toLowerCase().trim();
  const mapped = ESTADO_MAP[normalized];
  if (mapped !== undefined) {
    return { status: mapped, error: null };
  }
  return {
    status: "failed",
    error: {
      paso: "STATUS_MAPPING",
      motivo: `Unrecognized editor estado: "${estado}"`,
    },
  };
}

// ---------------------------------------------------------------------------
// Ordering validation (Zod schemas)
// ---------------------------------------------------------------------------

/**
 * Zod schema for a single ClipOrderEntry.
 */
export const ClipOrderEntrySchema = z.object({
  index: z.number().int().nonnegative(),
  clipId: z.string().min(1),
  isBroll: z.boolean(),
});

/**
 * Validates an ordering array of ClipOrderEntry[].
 *
 * Rules:
 * 1. Count must be between 1 and MAX_CLIPS_PER_JOB (inclusive).
 * 2. Indexes must be unique (no duplicates).
 * 3. Indexes must be contiguous starting from 0 (i.e., a permutation of 0..n-1).
 *
 * Returns { success: true, data } or { success: false, error }.
 */
export function validateOrdering(ordering: ClipOrderEntry[]): {
  success: boolean;
  error?: string;
} {
  const maxClips = getMaxClipsPerJob();

  // Rule 1: count within bounds
  if (ordering.length < 1) {
    return { success: false, error: "Ordering must contain at least 1 entry." };
  }
  if (ordering.length > maxClips) {
    return {
      success: false,
      error: `Ordering exceeds maximum of ${maxClips} clips.`,
    };
  }

  // Validate each entry with Zod
  for (let i = 0; i < ordering.length; i++) {
    const result = ClipOrderEntrySchema.safeParse(ordering[i]);
    if (!result.success) {
      return {
        success: false,
        error: `Invalid entry at position ${i}: ${result.error.message}`,
      };
    }
  }

  // Rule 2: unique indexes
  const indexes = ordering.map((e) => e.index);
  const uniqueIndexes = new Set(indexes);
  if (uniqueIndexes.size !== indexes.length) {
    return { success: false, error: "Ordering indexes must be unique (found duplicates)." };
  }

  // Rule 3: contiguous from 0..n-1 (a permutation)
  const n = ordering.length;
  for (let i = 0; i < n; i++) {
    if (!uniqueIndexes.has(i)) {
      return {
        success: false,
        error: `Ordering indexes must be contiguous from 0 to ${n - 1} (missing index ${i}).`,
      };
    }
  }

  return { success: true };
}

/**
 * Zod schema for validating EditOptions.ordering as a complete ordering.
 * This performs structural validation only (individual entries); use
 * validateOrdering() for the full semantic check (uniqueness, contiguity, count).
 */
export const EditOptionsOrderingSchema = z
  .array(ClipOrderEntrySchema)
  .min(1)
  .max(500);
