/**
 * Cola de jobs en backend (en memoria, dentro del proceso de Next).
 *
 * - Respeta dependencias: un job corre solo si su dependencia esta APROBADA ("done").
 * - Tras generar, el job queda en "awaiting_approval" (el usuario aprueba/regenera).
 * - Concurrencia limitada, reintentos con backoff exponencial + jitter.
 * - Pausar / reanudar / cancelar por proyecto.
 * - Idempotente: regenerar UN job no rehace el resto; lo aprobado queda lockeado.
 *
 * Singleton via globalThis para sobrevivir al HMR de Next en dev.
 */
import { config } from "../config";
import { jobsDb, projectsDb } from "../db";
import type { JobRecord, ProjectStatus } from "../types";
import { ProviderHttpError } from "../providers/types";
import {
  approveJob,
  logEvent,
  refreshManifest,
  runJobGeneration,
} from "./pipeline";

interface QueueState {
  activeProjects: Set<string>;
  pausedProjects: Set<string>;
  running: Set<string>;
  retryAt: Map<string, number>;
  pumping: boolean;
}

const globalForQueue = globalThis as unknown as { __augcQueue?: QueueState };
const state: QueueState =
  globalForQueue.__augcQueue ??
  (globalForQueue.__augcQueue = {
    activeProjects: new Set(),
    pausedProjects: new Set(),
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
  state.pausedProjects.delete(projectId);
  state.activeProjects.add(projectId);
  projectsDb.update(projectId, { status: "running" });
  pump();
}

/** Reencola un solo job (regenerar imagen/clip) sin tocar el resto. */
export function enqueueJob(jobId: string): void {
  const job = jobsDb.get(jobId);
  if (!job) return;
  const { rateLimitRetries, transientRetries, ...restMeta } = (job.meta ??
    {}) as Record<string, unknown>;
  void rateLimitRetries;
  void transientRetries;
  jobsDb.update(jobId, {
    status: "pending",
    error: null,
    attempts: 0,
    locked: false,
    // limpiamos candidatos/seleccion para imagenes (se regeneran)
    candidates: [],
    selectedIndex: null,
    outputPath: job.type === "image" ? null : job.outputPath,
    // reseteamos el contador de reintentos por rate limit (presupuesto fresco)
    meta: restMeta,
  });
  state.retryAt.delete(jobId);
  state.pausedProjects.delete(job.projectId);
  state.activeProjects.add(job.projectId);
  projectsDb.update(job.projectId, { status: "running" });
  logEvent(job.projectId, "info", `Regenerando "${job.refId}"`, { jobId });
  pump();
}

/** Pausa / reanuda / cancela el procesamiento de un proyecto. */
export function pauseProject(projectId: string): void {
  state.pausedProjects.add(projectId);
  projectsDb.update(projectId, { status: "paused" });
  logEvent(projectId, "warn", "Pipeline pausado.");
}
export function resumeProject(projectId: string): void {
  state.pausedProjects.delete(projectId);
  state.activeProjects.add(projectId);
  projectsDb.update(projectId, { status: "running" });
  logEvent(projectId, "info", "Pipeline reanudado.");
  pump();
}
export function cancelProject(projectId: string): void {
  state.pausedProjects.add(projectId);
  state.activeProjects.delete(projectId);
  projectsDb.update(projectId, { status: "paused" });
  logEvent(projectId, "warn", "Pipeline cancelado (los jobs en curso terminan).");
}

function runnableReason(job: JobRecord): "run" | "wait" | "dep-failed" {
  const base = depReason(job);
  if (base !== "run") return base;
  // Con auto-aprobacion no hay gate por lotes: la ventana de generacion la define
  // la concurrencia (p.ej. 3 a la vez, rolling). El gate solo aplica en modo manual.
  if (config.pipeline.autoApprove) return "run";
  // Gate por LOTES (modo manual): no arrancamos mas de approvalBatchSize jobs del MISMO
  // tipo que esten "sin aprobar" (generando + esperando aprobacion).
  const limit = config.pipeline.approvalBatchSize;
  if (limit > 0 && inFlightUnapproved(job.projectId, job.type) >= limit) {
    return "wait";
  }
  return "run";
}

/** Razon de ejecutabilidad SOLO por dependencias (sin el gate de lotes). */
function depReason(job: JobRecord): "run" | "wait" | "dep-failed" {
  if (job.status !== "pending") return "wait";
  const until = state.retryAt.get(job.id);
  if (until && Date.now() < until) return "wait";
  if (!job.dependsOn) return "run";
  const dep = jobsDb.get(job.dependsOn);
  if (!dep) return "dep-failed";
  if (dep.status === "done") return "run"; // dependencia APROBADA
  if (dep.status === "failed") return "dep-failed";
  return "wait"; // dep pending/generating/awaiting_approval
}

/** Jobs del mismo tipo que estan generandose o esperando aprobacion (sin aprobar aun). */
function inFlightUnapproved(projectId: string, type: JobRecord["type"]): number {
  return jobsDb
    .byProject(projectId)
    .filter(
      (j) =>
        j.type === type &&
        (j.status === "generating" || j.status === "awaiting_approval")
    ).length;
}

function collectPending(): JobRecord[] {
  const out: JobRecord[] = [];
  for (const projectId of state.activeProjects) {
    if (state.pausedProjects.has(projectId)) continue;
    out.push(...jobsDb.byProject(projectId).filter((j) => j.status === "pending"));
  }
  return out;
}

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
          logEvent(job.projectId, "error", `"${job.refId}" cancelado: la dependencia fallo.`, {
            jobId: job.id,
          });
        }
      }

      if (!started) {
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
      await runJobGeneration(job);
      if (config.pipeline.autoApprove) {
        // Auto-aprobacion: queda "done" y desbloquea lo que depende, sin esperar al usuario.
        // (para imagenes fija el candidato elegido como archivo canonico).
        await approveJob(job.id);
      } else {
        // Modo manual: espera aprobacion del usuario.
        jobsDb.update(job.id, { status: "awaiting_approval", error: null });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const current = jobsDb.get(job.id);

      // Errores TRANSITORIOS (no son fallas reales del job):
      //  - 429 / rate limit (cuota): esperar largo (Retry-After o rateLimitBackoffMs).
      //  - red ("fetch failed", timeout, conexion cortada): backoff exponencial corto.
      // Ambos reintentan SIN consumir los maxAttempts normales (cuenta aparte).
      const isRateLimit =
        err instanceof ProviderHttpError
          ? err.isRateLimit
          : /\(429\)|RESOURCE_EXHAUSTED|rate limit|quota/i.test(message);
      const isNetwork =
        !isRateLimit &&
        /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|terminated|UND_ERR|aborted|timed?\s?out|TimeoutError|AbortError/i.test(
          message
        );

      if (isRateLimit || isNetwork) {
        const tDone = ((current?.meta?.transientRetries as number) ?? 0) + 1;
        const maxT = config.pipeline.rateLimitMaxAttempts;
        if (tDone <= maxT) {
          const retryAfter =
            err instanceof ProviderHttpError ? err.retryAfterMs : undefined;
          const delay = isRateLimit
            ? (retryAfter ?? config.pipeline.rateLimitBackoffMs) +
              Math.random() * 2000
            : Math.min(
                config.pipeline.networkBackoffMs * 2 ** (tDone - 1),
                30000
              ) +
              Math.random() * 1000;
          state.retryAt.set(job.id, Date.now() + delay);
          const kind = isRateLimit ? "Rate limit (429)" : "Error de red";
          jobsDb.update(job.id, {
            // NO consumimos attempts normales: es transitorio, no una falla del job.
            attempts: job.attempts,
            status: "pending",
            error: `${kind}. Reintento ${tDone}/${maxT} en ${Math.round(
              delay / 1000
            )}s...`,
            meta: { ...(current?.meta ?? {}), transientRetries: tDone },
          });
          logEvent(
            job.projectId,
            "warn",
            `"${job.refId}" ${
              isRateLimit ? "rate limit (429)" : "error de red"
            }: espero ${Math.round(delay / 1000)}s y reintento (${tDone}/${maxT})${
              isRateLimit
                ? ". Tip: bajá PIPELINE_CONCURRENCY o subí el tier de cuota."
                : "."
            }`,
            { jobId: job.id }
          );
          setTimeout(() => pump(), delay + 50);
        } else {
          jobsDb.update(job.id, {
            status: "failed",
            error: `${
              isRateLimit ? "Rate limit (429)" : "Error de red"
            } persistente tras ${maxT} reintentos: ${message}`,
          });
          logEvent(
            job.projectId,
            "error",
            `"${job.refId}" fallo por ${
              isRateLimit ? "rate limit (429)" : "error de red"
            } persistente.`,
            { jobId: job.id }
          );
        }
        return; // el finally hace cleanup + pump
      }

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
        logEvent(job.projectId, "warn", `"${job.refId}" fallo (intento ${attempts}): ${message}`, {
          jobId: job.id,
        });
        setTimeout(() => pump(), delay + 50);
      } else {
        jobsDb.update(job.id, { status: "failed", error: message });
        logEvent(job.projectId, "error", `"${job.refId}" fallo definitivamente: ${message}`, {
          jobId: job.id,
        });
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

function finalizeProjects(): void {
  for (const projectId of Array.from(state.activeProjects)) {
    if (state.pausedProjects.has(projectId)) {
      continue; // pausado: no finalizamos
    }
    const jobs = jobsDb.byProject(projectId);
    const generating = jobs.some((j) => j.status === "generating");
    const runnablePending = jobs.some(
      (j) => j.status === "pending" && runnableReason(j) === "run"
    );
    if (generating || runnablePending) continue; // sigue trabajando

    const awaiting = jobs.some((j) => j.status === "awaiting_approval");
    if (awaiting) {
      projectsDb.update(projectId, { status: "review" });
      // Si quedan jobs pendientes, es que el GATE por lotes freno la generacion:
      // avisamos para que el usuario apruebe el lote y siga el resto.
      const morePending = jobs.some((j) => j.status === "pending");
      const awaitingCount = jobs.filter(
        (j) => j.status === "awaiting_approval"
      ).length;
      if (morePending && config.pipeline.approvalBatchSize > 0) {
        logEvent(
          projectId,
          "info",
          `Lote de ${awaitingCount} listo. Aprobalos para seguir generando el resto (de a ${config.pipeline.approvalBatchSize}).`
        );
      }
      state.activeProjects.delete(projectId); // se re-activa al aprobar/regenerar
      void refreshManifest(projectId);
      continue;
    }

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

export function queueSnapshot() {
  return {
    activeProjects: Array.from(state.activeProjects),
    pausedProjects: Array.from(state.pausedProjects),
    running: Array.from(state.running),
    concurrency: config.pipeline.concurrency,
  };
}
