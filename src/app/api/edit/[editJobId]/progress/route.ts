/**
 * GET /api/edit/[editJobId]/progress — Poll edit job progress.
 *
 * Queries the editor's /progreso/{id} within a 5s budget, normalizes the
 * response via statusMap, and applies monotonic (max) merge on porcentaje
 * so it never decreases across reads.
 *
 * Requirements: 5.1-5.8, 5.10, 5.11, 8.5, 8.6
 */

import { NextResponse } from "next/server";
import { editJobsDb } from "@/lib/edit/editJobStore";
import { createEditorClient } from "@/lib/edit/editorClient";
import { mapEditorEstado } from "@/lib/edit/statusMap";
import type { EditJob, EditorProgress, EditJobError } from "@/lib/edit/types";
import type { EditJobStore } from "@/lib/edit/editJobStore";
import type { EditorClient } from "@/lib/edit/editorClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Dependency injection (overridable for tests)
// ---------------------------------------------------------------------------

export interface ProgressRouteDeps {
  editJobStore: EditJobStore;
  createClient: () => EditorClient;
}

const defaultDeps: ProgressRouteDeps = {
  editJobStore: editJobsDb,
  createClient: () => createEditorClient({ timeoutMs: 5_000, retry: { maxAttempts: 1 } }),
};

let currentDeps: ProgressRouteDeps = defaultDeps;

export function __setDeps(deps: Partial<ProgressRouteDeps>): void {
  currentDeps = { ...defaultDeps, ...deps };
}

export function __resetDeps(): void {
  currentDeps = defaultDeps;
}

// ---------------------------------------------------------------------------
// Editor raw progress response shape (from /progreso/{id})
// ---------------------------------------------------------------------------

interface EditorRawProgress {
  porcentaje?: number;
  paso_actual?: string | null;
  mensaje?: string;
  error?: { paso?: string; motivo?: string } | null;
  estado?: string;
}

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

export async function GET(
  _req: Request,
  { params }: { params: { editJobId: string } }
): Promise<Response> {
  const { editJobId } = params;

  // Look up the EditJob
  const job = currentDeps.editJobStore.getEditJob(editJobId);
  if (!job) {
    return NextResponse.json(
      { error: `Edit job not found: ${editJobId}` },
      { status: 404 }
    );
  }

  // If no editorJobId yet, report 0% (Req 5.4)
  if (!job.editorJobId) {
    return NextResponse.json({
      editJobId: job.id,
      status: job.status,
      progress: job.progress,
      live: true,
    });
  }

  // If already terminal, just return stored state (no need to query editor)
  if (job.status === "completed" || job.status === "failed") {
    return NextResponse.json({
      editJobId: job.id,
      status: job.status,
      progress: job.progress,
      live: true,
    });
  }

  // Query editor /progreso/{id} within 5s budget
  const client = currentDeps.createClient();
  let rawProgress: EditorRawProgress;
  let live = true;

  try {
    rawProgress = (await client.progreso(job.editorJobId)) as unknown as EditorRawProgress;
  } catch {
    // Req 5.11: On network error / 5xx / timeout > 5s:
    // return last recorded progress, indicate live progress unavailable,
    // preserve current status.
    return NextResponse.json({
      editJobId: job.id,
      status: job.status,
      progress: job.progress,
      live: false,
      message: "Live progress temporarily unavailable",
    });
  }

  // Normalize the editor response
  const incomingPorcentaje = typeof rawProgress.porcentaje === "number"
    ? rawProgress.porcentaje
    : 0;

  // Monotonic max-merge: never decrease (Req 5.3, 8.3)
  const mergedPorcentaje = Math.max(
    job.progress.porcentaje,
    Math.max(0, Math.min(100, Math.floor(incomingPorcentaje)))
  );

  const pasoActual = rawProgress.paso_actual ?? null;
  const mensaje = rawProgress.mensaje ?? "";

  // Map estado to normalized status (Req 8.2, 8.5)
  let newStatus = job.status;
  let newError: EditJobError | null = job.error;

  if (rawProgress.estado) {
    const mapped = mapEditorEstado(rawProgress.estado);
    if (mapped.error) {
      // Unrecognized estado → set failed (Req 8.5)
      newStatus = "failed";
      newError = mapped.error;
    } else {
      newStatus = mapped.status;
      // Req 5.6: COMPLETADO → completed
      // Req 5.7: FALLIDO → failed
      // Req 5.8: awaiting states → awaiting_edit
      if (mapped.status === "failed" && rawProgress.error) {
        newError = {
          paso: rawProgress.error.paso ?? "UNKNOWN",
          motivo: rawProgress.error.motivo ?? "Unknown error",
        };
      }
    }
  }

  // Build the new progress
  const newProgress: EditorProgress = {
    porcentaje: mergedPorcentaje,
    pasoActual,
    mensaje,
    error: newStatus === "failed" ? newError : null,
  };

  // Update the EditJob with new status and progress
  const patch: Partial<EditJob> = {
    status: newStatus,
    progress: newProgress,
  };
  if (newError && newStatus === "failed") {
    patch.error = newError;
  }

  await currentDeps.editJobStore.updateEditJob(editJobId, patch);

  return NextResponse.json({
    editJobId: job.id,
    status: newStatus,
    progress: newProgress,
    live,
  });
}
