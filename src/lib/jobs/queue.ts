/**
 * Cola de jobs en backend (en memoria, dentro del proceso de Next).
 *
 * - Respeta dependencias (un job corre solo si su dependsOn esta "done").
 * - Concurrencia limitada (config.pipeline.concurrency).
 * - Reintentos con backoff exponencial + jitter.
 * - Idempotente: regenerar UN job no rehace el resto.
 *
 * Singleton via globalThis para sobrevivir al HMR de Next en dev.
 */
import { config } from "../config";
import { jobsDb, projectsDb } from "../db";
import type { JobRecord, ProjectStatus } from "../types";
import { executeJob, refreshManifest } from "./pipeline";

interface QueueState {
  activeProjects: Set<string>;
  running: Set<string>; // job ids en ejecucion
  retryAt: Map<string, number>; // job id -> timestamp minimo para reintentar
  pumping: boolean;
}

const globalForQueue = globalThis as unknown as { __augcQueue?: QueueState };
const state: QueueState =
  globalForQueue.__augcQueue ??
  (globalForQueue.__augcQueue = {
    activeProjects: new Set(),
    running: new Set(),
    retryAt: new Map(),
    pumping: false,
  });

function backoffDelay(attempt: number): number {
  const base = config.pipeline.backoffBaseMs;
  const exp = base * Math.pow(2, Math.max(0, attempt - 1));
  const jitter = Math.random() * base;
  return Math.min(exp + jitter, 60_000);
}

/** Marca el proyecto para procesar y arranca el bombeo. */
export function enqueueProject(projectId: string): void {
  state.activeProjects.add(projectId);
  projectsDb.update(projectId, { status: "running" });
  pump();
}

/** Reencola un solo job (regenerar imagen/clip) sin tocar el resto. */
export function enqueueJob(jobId: string): void {
  const job = jobsDb.get(jobId);
  if (!job) return;
  jobsDb.update(jobId, {
    status: "pending",
    error: null,
    attempts: 0,
    outputPath: job.type === "image" ? null : job.outputPath,
  });
  state.retryAt.delete(jobId);
  state.activeProjects.add(job.projectId);
  projectsDb.update(job.projectId, { status: "running" });
  pump();
}

/** Determina si un job puede correr ahora (deps done, no en backoff). */
function runnableReason(job: JobRecord): "run" | "wait" | "dep-failed" {
  if (job.status !== "pending") return "wait";
  const until = state.retryAt.get(job.id);
  if (until && Date.now() < until) return "wait";
  if (!job.dependsOn) return "run";
  const dep = jobsDb.get(job.dependsOn);
  if (!dep) return "dep-failed";
  if (dep.status === "done") return "run";
  if (dep.status === "failed") return "dep-failed";
  return "wait";
}

function collectPending(): JobRecord[] {
  const out: JobRecord[] = [];
  for (const projectId of state.activeProjects) {
    out.push(...jobsDb.byProject(projectId).filter((j) => j.status === "pending"));
  }
  return out;
}

/** Bombea jobs runnable hasta el limite de concurrencia. */
function pump(): void {
  if (state.pumping) return;
  state.pumping = true;
  try {
    let scheduledRetryTick = false;
    while (state.running.size < config.pipeline.concurrency) {
      const pending = collectPending();
      if (pending.length === 0) break;

      let started = false;
      for (const job of pending) {
        if (state.running.size >= config.pipeline.concurrency) break;
        const reason = runnableReason(job);
        if (reason === "run") {
          startJob(job);
          started = true;
        } else if (reason === "dep-failed") {
          jobsDb.update(job.id, {
            status: "failed",
            error: "La dependencia (imagen previa) fallo, no se puede generar.",
          });
        }
      }

      if (!started) {
        // Hay pendientes pero ninguno runnable ahora (esperando deps o backoff).
        if (!scheduledRetryTick) {
          scheduledRetryTick = true;
          setTimeout(() => pump(), 500);
        }
        break;
      }
    }
  } finally {
    state.pumping = false;
  }
  finalizeProjects();
}

function startJob(job: JobRecord): void {
  state.running.add(job.id);
  jobsDb.update(job.id, {
    status: "generating",
    attempts: job.attempts + 1,
    error: null,
  });

  void (async () => {
    try {
      const outputPath = await executeJob(job);
      jobsDb.update(job.id, { status: "done", outputPath, error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const current = jobsDb.get(job.id);
      const attempts = current?.attempts ?? job.attempts + 1;
      if (attempts < (current?.maxAttempts ?? config.pipeline.maxAttempts)) {
        const delay = backoffDelay(attempts);
        state.retryAt.set(job.id, Date.now() + delay);
        jobsDb.update(job.id, {
          status: "pending",
          error: `Intento ${attempts} fallo: ${message}. Reintentando en ${Math.round(
            delay / 1000
          )}s...`,
        });
        setTimeout(() => pump(), delay + 50);
      } else {
        jobsDb.update(job.id, { status: "failed", error: message });
      }
    } finally {
      state.running.delete(job.id);
      try {
        await refreshManifest(job.projectId);
      } catch {
        /* manifest best-effort */
      }
      pump();
    }
  })();
}

/** Si un proyecto no tiene jobs pendientes/en curso, fija su estado final. */
function finalizeProjects(): void {
  for (const projectId of Array.from(state.activeProjects)) {
    const jobs = jobsDb.byProject(projectId);
    const anyActive = jobs.some(
      (j) => j.status === "pending" || j.status === "generating"
    );
    if (anyActive) continue;

    const anyFailed = jobs.some((j) => j.status === "failed");
    const anyDone = jobs.some((j) => j.status === "done");
    let status: ProjectStatus = "done";
    if (anyFailed && anyDone) status = "partial";
    else if (anyFailed) status = "failed";
    projectsDb.update(projectId, { status });
    state.activeProjects.delete(projectId);
    void refreshManifest(projectId);
  }
}

/** Snapshot del estado de la cola (para debug/UI). */
export function queueSnapshot() {
  return {
    activeProjects: Array.from(state.activeProjects),
    running: Array.from(state.running),
    concurrency: config.pipeline.concurrency,
  };
}
