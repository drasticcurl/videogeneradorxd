import { NextResponse } from "next/server";
import { editJobsDb, type EditJobStore } from "./editJobStore";
import { createEditorClient, type EditorClient } from "./editorClient";
import { createEditStorageAdapter } from "./storageFactory";
import type { StorageAdapter } from "./storageAdapter";
import {
  mapEditorEstado,
  buildCorrelation,
  reconcileEventForStatus,
  type EditCorrelation,
  type ReconcileEventType,
} from "./statusMap";
import { EditorPermanentError } from "./retry";
import { getServerDiagnostics } from "../version";
import type { EditJob, EditJobError, EditorProgress } from "./types";

interface EditorRawProgress {
  porcentaje?: number;
  paso_actual?: string | null;
  mensaje?: string;
  error?: { paso?: string; motivo?: string } | null;
  estado?: string;
}

export interface ReconcileDeps {
  editJobStore: EditJobStore;
  createClient: () => EditorClient;
  getStorageAdapter: (projectId: string) => StorageAdapter;
}

export interface ReconcileResult {
  job: EditJob;
  live: boolean;
  message?: string;
  /**
   * End-to-end correlation tuple for this observation (spec `unir-step-hang`,
   * Task 3.4). Threaded onto every reconcile result so an affected job at the
   * opaque 25% boundary is observable/classifiable (category C) from a
   * correlated event, independent of the (monotonic) percentage.
   */
  correlation?: EditCorrelation;
  /**
   * Differentiated reconcile event kind for this observation (spec
   * `unir-step-hang`, Task 3.5). Distinguishes the reached-but-un-propagated
   * pause (`reconcile_awaiting_silences`, category C) from a lost editor job
   * (`editor_state_lost`) and a status-mapping failure, so the last confirmed
   * reconciliation event localizes the stall.
   */
  eventType?: ReconcileEventType;
}

/** The three actionable pause statuses treated as live, non-terminal states. */
const AWAITING_STATUSES = new Set<EditJob["status"]>([
  "awaiting_silences",
  "awaiting_subtitles",
  "awaiting_final_render",
]);

/** True when the job is in one of the three actionable pause statuses. */
export function isAwaitingStatus(status: EditJob["status"]): boolean {
  return AWAITING_STATUSES.has(status);
}

const defaultDeps: ReconcileDeps = {
  editJobStore: editJobsDb,
  createClient: () => createEditorClient({ timeoutMs: 5_000, retry: { maxAttempts: 1 } }),
  getStorageAdapter: createEditStorageAdapter,
};

async function detectDurableOutput(
  job: EditJob,
  deps: ReconcileDeps
): Promise<EditJob | undefined> {
  try {
    const outputKey = await deps
      .getStorageAdapter(job.projectId)
      .persistOutput(job.id, "final.mp4");
    if (!outputKey) return undefined;

    const current = deps.editJobStore.getEditJob(job.id) ?? job;
    const progress: EditorProgress = {
      ...current.progress,
      porcentaje: 100,
      mensaje: current.progress.mensaje || "Edited video stored",
      error: null,
    };
    return (await deps.editJobStore.updateEditJob(job.id, {
      status: "completed",
      outputKey,
      error: null,
      progress,
    })) ?? { ...current, status: "completed", outputKey, error: null, progress };
  } catch (error) {
    console.warn("[edit/reconcile] durable output check failed", {
      editJobId: job.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * Reconcile one generator EditJob with durable storage and FastAPI state.
 * Durable output is checked first so a process restart cannot turn an already
 * completed video into a failure merely because FastAPI's in-memory job is gone.
 *
 * Every result is stamped with the end-to-end correlation tuple (version,
 * revision, editJobId, editorJobId) so the observation is classifiable
 * end-to-end (spec `unir-step-hang`, Task 3.4). The correlation carries only
 * identifiers/state — never video content and never the percentage as state.
 */
export async function reconcileEditJob(
  editJobId: string,
  deps: ReconcileDeps = defaultDeps
): Promise<ReconcileResult | undefined> {
  const result = await reconcileEditJobCore(editJobId, deps);
  if (!result) return result;
  return {
    ...result,
    correlation: correlationForJob(result.job),
    eventType: reconcileEventForStatus(result.job.status, result.job.error),
  };
}

/** Builds the correlation tuple for a job from build/revision diagnostics. */
function correlationForJob(job: EditJob): EditCorrelation {
  const diag = getServerDiagnostics();
  return buildCorrelation({
    editJobId: job.id,
    editorJobId: job.editorJobId,
    version: diag.version,
    revision: diag.revision,
  });
}

async function reconcileEditJobCore(
  editJobId: string,
  deps: ReconcileDeps = defaultDeps
): Promise<ReconcileResult | undefined> {
  let job = deps.editJobStore.getEditJob(editJobId);
  if (!job) return undefined;
  if (job.status === "completed" || job.status === "failed") {
    return { job, live: true };
  }

  const durableJob = await detectDurableOutput(job, deps);
  if (durableJob) return { job: durableJob, live: true };

  job = deps.editJobStore.getEditJob(editJobId) ?? job;
  if (!job.editorJobId) return { job, live: true };

  let rawProgress: EditorRawProgress;
  try {
    rawProgress = (await deps.createClient().progreso(job.editorJobId)) as unknown as EditorRawProgress;
  } catch (error) {
    if (error instanceof EditorPermanentError) {
      // Close the small race between the preflight durable check and a 404.
      const recovered = await detectDurableOutput(job, deps);
      if (recovered) return { job: recovered, live: true };

      // A 404 means the editor's in-memory job was lost (e.g. container
      // restart). If the job was paused (awaiting_*), surface an actionable
      // EDITOR_STATE_LOST reason so the user can re-run rather than hang.
      const wasPaused = isAwaitingStatus(job.status);
      const reason = error.statusCode === 404
        ? (wasPaused
            ? "Editor restarted; paused edit state lost — re-run the edit."
            : "Editor job state was lost and no durable final.mp4 exists")
        : `Editor rejected progress reconciliation (${error.statusCode ?? "4xx"})`;
      const jobError: EditJobError = {
        paso: error.statusCode === 404 && wasPaused ? "EDITOR_STATE_LOST" : "PROGRESO",
        motivo: reason,
      };
      const failed = await deps.editJobStore.updateEditJob(editJobId, {
        status: "failed",
        outputKey: null,
        error: jobError,
        progress: {
          ...job.progress,
          mensaje: reason,
          error: jobError,
        },
      });
      return { job: failed ?? { ...job, status: "failed", error: jobError }, live: false, message: reason };
    }

    return {
      job: deps.editJobStore.getEditJob(editJobId) ?? job,
      live: false,
      message: "Live progress temporarily unavailable",
    };
  }

  const current = deps.editJobStore.getEditJob(editJobId) ?? job;
  if (current.status === "completed" || current.status === "failed") {
    return { job: current, live: true };
  }

  const incoming = typeof rawProgress.porcentaje === "number" ? rawProgress.porcentaje : 0;
  const porcentaje = Math.max(
    current.progress.porcentaje,
    Math.max(0, Math.min(100, Math.floor(incoming)))
  );
  let status: EditJob["status"] = current.status;
  let error: EditJobError | null = current.error;

  if (rawProgress.estado) {
    const mapped = mapEditorEstado(rawProgress.estado);
    if (mapped.error) {
      status = "failed";
      error = mapped.error;
    } else {
      status = mapped.status;
      if (status === "failed") {
        error = {
          paso: rawProgress.error?.paso ?? "UNKNOWN",
          motivo: rawProgress.error?.motivo ?? "Unknown error",
        };
      }
    }
  }

  if (status === "completed") {
    const completed = await detectDurableOutput(current, deps);
    if (completed) return { job: completed, live: true };
    status = "failed";
    error = {
      paso: "OUTPUT",
      motivo: "Editor completed but durable final.mp4 is unavailable",
    };
  }

  const progress: EditorProgress = {
    porcentaje,
    pasoActual: rawProgress.paso_actual ?? null,
    mensaje: rawProgress.mensaje ?? "",
    error: status === "failed" ? error : null,
  };
  const patch: Partial<EditJob> = { status, progress };
  if (status === "failed" && error) {
    patch.error = error;
    patch.outputKey = null;
  } else {
    patch.error = null;
  }

  const updated = await deps.editJobStore.updateEditJob(editJobId, patch);
  return { job: updated ?? { ...current, ...patch }, live: true };
}

/**
 * Recoverable-lost path for the POST pass-through routes.
 *
 * Invoked when the editor returns 404 for a job the generator believes is
 * paused/running (the editor's in-memory JobManager was dropped on restart).
 * Runs an output-first durable re-check: if a durable final.mp4 exists the job
 * transitions to `completed` (200); otherwise it transitions to `failed` with
 * `{paso:"EDITOR_STATE_LOST", motivo}` (409) — never leaving the job silently
 * awaiting.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.5, 10.5
 */
export async function recoverableLost(
  editJobId: string,
  deps: Pick<ReconcileDeps, "editJobStore" | "getStorageAdapter">,
): Promise<Response> {
  const job = deps.editJobStore.getEditJob(editJobId);
  if (!job) {
    return NextResponse.json(
      { error: `Edit job not found: ${editJobId}` },
      { status: 404 },
    );
  }

  const recovered = await detectDurableOutput(job, {
    ...defaultDeps,
    editJobStore: deps.editJobStore,
    getStorageAdapter: deps.getStorageAdapter,
  });
  if (recovered) {
    return NextResponse.json(
      { editJobId, status: "completed" },
      { status: 200 },
    );
  }

  const motivo = "Editor restarted; paused edit state lost — re-run the edit.";
  const jobError: EditJobError = { paso: "EDITOR_STATE_LOST", motivo };
  await deps.editJobStore.updateEditJob(editJobId, {
    status: "failed",
    outputKey: null,
    error: jobError,
    progress: { ...job.progress, mensaje: motivo, error: jobError },
  });
  return NextResponse.json(
    { editJobId, status: "failed", error: jobError },
    { status: 409 },
  );
}

const globalForMonitors = globalThis as unknown as {
  __activeEditJobMonitors?: Set<string>;
};
const activeMonitors = globalForMonitors.__activeEditJobMonitors ??=
  new Set<string>();

export interface MonitorOptions {
  minDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Start one detached, in-process monitor. Duplicate starts are ignored. */
export function launchEditJobMonitor(
  editJobId: string,
  deps: ReconcileDeps = defaultDeps,
  options: MonitorOptions = {}
): void {
  if (activeMonitors.has(editJobId)) {
    console.log("[edit/monitor] monitor already active", { editJobId });
    return;
  }
  activeMonitors.add(editJobId);

  const minDelayMs = Math.max(250, options.minDelayMs ?? 2_000);
  const maxDelayMs = Math.max(minDelayMs, options.maxDelayMs ?? 15_000);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  void (async () => {
    let delayMs = minDelayMs;
    console.log("[edit/monitor] started", { editJobId });
    while (true) {
      try {
        const result = await reconcileEditJob(editJobId, deps);
        if (!result) {
          console.warn("[edit/monitor] job disappeared", { editJobId });
          return;
        }
        if (result.job.status === "completed" || result.job.status === "failed") {
          console.log("[edit/monitor] terminal", { editJobId, status: result.job.status });
          return;
        }
        delayMs = result.live ? minDelayMs : Math.min(maxDelayMs, delayMs * 2);
      } catch (error) {
        delayMs = Math.min(maxDelayMs, delayMs * 2);
        console.error("[edit/monitor] reconciliation failed", {
          editJobId,
          retryInMs: delayMs,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await sleep(delayMs);
    }
  })()
    .catch((error) => {
      console.error("[edit/monitor] unexpected monitor rejection", {
        editJobId,
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      activeMonitors.delete(editJobId);
    });
}

export function __hasActiveEditJobMonitor(editJobId: string): boolean {
  return activeMonitors.has(editJobId);
}
