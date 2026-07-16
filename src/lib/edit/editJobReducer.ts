/**
 * EditJob reducer — pure state transitions for the edit job lifecycle.
 *
 * The reducer enforces the state machine:
 *   queued → uploading → running → (awaiting_* ⇄ running) → completed | failed
 *   where awaiting_* is one of awaiting_silences / awaiting_subtitles /
 *   awaiting_final_render.
 *
 * Invariants enforced:
 * - editorJobId is null only in queued, uploading, or pre-accept failed states.
 * - progress.porcentaje is non-decreasing and clamped to [0, 100] integer.
 * - Terminal states (completed, failed) are absorbing — no further transitions.
 *
 * Requirements: 5, 8
 */

import type { EditJob, EditJobStatus, EditorProgress, EditJobError } from "./types";

/** The three actionable pause statuses the editor can enter. */
export type AwaitingStatus =
  | "awaiting_silences"
  | "awaiting_subtitles"
  | "awaiting_final_render";

// ---------------------------------------------------------------------------
// Action types
// ---------------------------------------------------------------------------

export type EditJobAction =
  | { type: "UPLOAD_STARTED" }
  | { type: "UPLOAD_COMPLETED"; editorJobId: string }
  | { type: "PROGRESS_UPDATE"; porcentaje: number; pasoActual: string | null; mensaje: string }
  | { type: "AWAITING_EDIT"; status: AwaitingStatus; pasoActual: string | null; mensaje: string }
  | { type: "RESUMED" }
  | { type: "COMPLETED"; outputKey: string }
  | { type: "FAILED"; error: EditJobError };

// ---------------------------------------------------------------------------
// Allowed transitions
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Record<EditJobStatus, EditJobStatus[]> = {
  queued: ["uploading", "failed"],
  uploading: ["running", "failed"],
  running: [
    "awaiting_silences",
    "awaiting_subtitles",
    "awaiting_final_render",
    "completed",
    "failed",
  ],
  awaiting_silences: ["running", "failed"],
  awaiting_subtitles: ["running", "failed"],
  awaiting_final_render: ["running", "failed"],
  completed: [],
  failed: [],
};

function canTransition(from: EditJobStatus, to: EditJobStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Progress clamping helper
// ---------------------------------------------------------------------------

/**
 * Clamps porcentaje to a non-decreasing integer within [0, 100].
 * The new value is max(current, clamp(incoming, 0, 100)).
 */
function clampProgress(current: number, incoming: number): number {
  const clamped = Math.max(0, Math.min(100, Math.floor(incoming)));
  return Math.max(current, clamped);
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * Pure reducer for EditJob state transitions.
 * Returns the new EditJob state or the unchanged state if the transition is invalid.
 */
export function editJobReducer(state: EditJob, action: EditJobAction): EditJob {
  const now = new Date().toISOString();

  switch (action.type) {
    case "UPLOAD_STARTED": {
      if (!canTransition(state.status, "uploading")) return state;
      return {
        ...state,
        status: "uploading",
        updatedAt: now,
      };
    }

    case "UPLOAD_COMPLETED": {
      if (!canTransition(state.status, "running")) return state;
      return {
        ...state,
        status: "running",
        editorJobId: action.editorJobId,
        updatedAt: now,
      };
    }

    case "PROGRESS_UPDATE": {
      // Progress updates are only meaningful while running
      if (state.status !== "running") return state;
      const newPorcentaje = clampProgress(state.progress.porcentaje, action.porcentaje);
      const newProgress: EditorProgress = {
        porcentaje: newPorcentaje,
        pasoActual: action.pasoActual,
        mensaje: action.mensaje,
        error: null,
      };
      return {
        ...state,
        progress: newProgress,
        updatedAt: now,
      };
    }

    case "AWAITING_EDIT": {
      if (!canTransition(state.status, action.status)) return state;
      const newPorcentaje = state.progress.porcentaje; // preserve current
      return {
        ...state,
        status: action.status,
        progress: {
          porcentaje: newPorcentaje,
          pasoActual: action.pasoActual,
          mensaje: action.mensaje,
          error: null,
        },
        updatedAt: now,
      };
    }

    case "RESUMED": {
      if (!canTransition(state.status, "running")) return state;
      return {
        ...state,
        status: "running",
        updatedAt: now,
      };
    }

    case "COMPLETED": {
      if (!canTransition(state.status, "completed")) return state;
      return {
        ...state,
        status: "completed",
        progress: {
          ...state.progress,
          porcentaje: 100,
          error: null,
        },
        outputKey: action.outputKey,
        error: null,
        updatedAt: now,
      };
    }

    case "FAILED": {
      if (!canTransition(state.status, "failed")) return state;
      return {
        ...state,
        status: "failed",
        progress: {
          ...state.progress,
          error: action.error,
        },
        error: action.error,
        updatedAt: now,
      };
    }

    default:
      return state;
  }
}
