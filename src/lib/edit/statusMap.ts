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
  esperando_edicion_silencios: "awaiting_edit",
  esperando_revision: "awaiting_edit",
  esperando_edicion_final: "awaiting_edit",
  completado: "completed",
  fallido: "failed",
};

export interface MapEditorEstadoResult {
  status: EditJobStatus;
  /** Non-null only when the estado was unrecognized → forced to failed. */
  error: { paso: string; motivo: string } | null;
}

/**
 * Maps an editor estado string to the normalized EditJobStatus.
 *
 * - EN_COLA → queued
 * - EN_EJECUCION → running
 * - ESPERANDO_EDICION_SILENCIOS / ESPERANDO_REVISION / ESPERANDO_EDICION_FINAL → awaiting_edit
 * - COMPLETADO → completed
 * - FALLIDO → failed
 * - Unrecognized → failed with error
 *
 * The comparison is case-insensitive and uses the lowercase form.
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
