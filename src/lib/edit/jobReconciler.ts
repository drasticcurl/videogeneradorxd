import { editJobsDb, type EditJobStore } from "./editJobStore";
import { createEditorClient, type EditorClient } from "./editorClient";
import { createEditStorageAdapter } from "./storageFactory";
import type { StorageAdapter } from "./storageAdapter";
import { mapEditorEstado } from "./statusMap";
import { EditorPermanentError } from "./retry";
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
 */
export async function reconcileEditJob(
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

      const reason = error.statusCode === 404
        ? "Editor job state was lost and no durable final.mp4 exists"
        : `Editor rejected progress reconciliation (${error.statusCode ?? "4xx"})`;
      const jobError: EditJobError = { paso: "PROGRESO", motivo: reason };
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
