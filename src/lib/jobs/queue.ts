/**
 * Cola de jobs en backend (en memoria, dentro del proceso de Next).
 *
 * - Respeta dependencias: un job corre solo si su dependencia esta APROBADA ("done").
 * - Con auto-aprobacion (default) cada job queda "done" al terminar; en modo manual
 *   queda "awaiting_approval" (el usuario aprueba/regenera).
 * - Concurrencia limitada (ventana rolling), reintentos con backoff exponencial + jitter.
 * - Pausar / reanudar / cancelar por proyecto.
 * - Idempotente: regenerar UN job no rehace el resto; lo aprobado queda lockeado.
 * - Reconcilia jobs colgados en "generating" (ej: tras reiniciar el server).
 *
 * Singleton via globalThis para sobrevivir al HMR de Next en dev.
 */
import { config } from "../config";
import { jobsDb, projectsDb } from "../db";
import type { JobRecord, JobType, ProjectStatus } from "../types";
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
  /** timestamps de los ultimos arranques de VIDEO (ventana deslizante de rate limit) */
  videoStarts: number[];
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
    videoStarts: [],
  });
// Defensivo: si el estado venia de una version anterior (HMR) puede no tener el campo.
if (!state.videoStarts) state.videoStarts = [];

/**
 * Rate limit de VIDEO: como maximo N arranques por ventana (default 4 por minuto).
 * Devuelve 0 si se puede arrancar ya, o los ms que faltan para el proximo slot.
 */
function videoRateWaitMs(): number {
  const { videoRateMax, videoRateWindowMs } = config.pipeline;
  const now = Date.now();
  // Descartamos los arranques que salieron de la ventana.
  state.videoStarts = state.videoStarts.filter((t) => now - t < videoRateWindowMs);
  if (state.videoStarts.length < videoRateMax) return 0;
  const oldest = Math.min(...state.videoStarts);
  return Math.max(250, videoRateWindowMs - (now - oldest));
}

/**
 * Un job que se quedo sin reintentos. Los VIDEOS no se marcan failed de una: vuelven
 * a la cola desde cero (presupuesto de intentos nuevo) hasta videoRequeueMax veces,
 * porque casi siempre es cuota/red y con esperar un rato salen. Recien despues, failed.
 */
function requeueOrFail(job: JobRecord, message: string): void {
  const current = jobsDb.get(job.id);
  const meta = (current?.meta ?? {}) as Record<string, unknown>;
  const requeues = ((meta.requeues as number) ?? 0) + 1;

  if (job.type === "video" && requeues <= config.pipeline.videoRequeueMax) {
    const delay = config.pipeline.videoRateWindowMs;
    state.retryAt.set(job.id, Date.now() + delay);
    jobsDb.update(job.id, {
      status: "pending",
      attempts: 0,
      error: `${message} — vuelve a la cola (reintento ${requeues}/${config.pipeline.videoRequeueMax}).`,
      meta: { ...meta, requeues, transientRetries: 0 },
    });
    logEvent(
      job.projectId,
      "warn",
      `"${job.refId}" fallo y vuelve a la cola (${requeues}/${config.pipeline.videoRequeueMax}), en ${Math.round(
        delay / 1000
      )}s.`,
      { jobId: job.id }
    );
    setTimeout(() => pump(), delay + 50);
    return;
  }

  jobsDb.update(job.id, { status: "failed", error: message });
  logEvent(job.projectId, "error", `"${job.refId}" fallo definitivamente: ${message}`, {
    jobId: job.id,
  });
}

function backoffDelay(attempt: number): number {
  const base = config.pipeline.backoffBaseMs;
  const exp = base * Math.pow(2, Math.max(0, attempt - 1));
  const jitter = Math.random() * base;
  return Math.min(exp + jitter, 60_000);
}

/**
 * Auto-approve EFECTIVO para un proyecto: si el proyecto guardo override
 * (autoApprove: true|false) lo usa; si no, cae al default global de config.
 * Asi cada proyecto decide al crearse si quiere aprobar a mano o no.
 */
function isProjectAutoApprove(projectId: string): boolean {
  const project = projectsDb.get(projectId);
  if (project && typeof project.autoApprove === "boolean") {
    return project.autoApprove;
  }
  return config.pipeline.autoApprove;
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
  const { rateLimitRetries, transientRetries, requeues, ...restMeta } = (job.meta ??
    {}) as Record<string, unknown>;
  void rateLimitRetries;
  void transientRetries;
  void requeues; // reintento manual = presupuesto de reencolados nuevo
  // Si estaba (o quedo) marcado como corriendo, liberamos el slot para poder regenerar
  // aunque el job estuviera colgado en "generating".
  state.running.delete(jobId);
  jobsDb.update(jobId, {
    status: "pending",
    error: null,
    attempts: 0,
    locked: false,
    // Limpiamos candidatos/seleccion y TAMBIEN el outputPath (imagen y video): asi al
    // regenerar se "saca" el aprobado, se muestra "generando", y cuando termina aparece
    // el NUEVO archivo (antes el video viejo quedaba pegado encima del que se generaba).
    candidates: [],
    selectedIndex: null,
    outputPath: null,
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

/**
 * Resetea jobs que quedaron colgados en "generating" pero que NO estan realmente
 * corriendo (tipico tras reiniciar el server: la DB dice "generating" pero el proceso
 * en memoria perdio el estado). Los vuelve a "pending" para que la cola los retome.
 */
function reconcileStuckJobs(): void {
  for (const projectId of state.activeProjects) {
    if (state.pausedProjects.has(projectId)) continue;
    for (const j of jobsDb.byProject(projectId)) {
      if (j.status === "generating" && !state.running.has(j.id)) {
        jobsDb.update(j.id, {
          status: "pending",
          error: "Estaba colgado en 'generando'; se reencola automaticamente.",
        });
        logEvent(
          projectId,
          "warn",
          `"${j.refId}" estaba colgado en 'generando'; lo reencolo.`,
          { jobId: j.id }
        );
      }
    }
  }
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

/**
 * Reintenta los jobs ROTOS de un proyecto y devuelve los ids reencolados:
 *  - status "failed": se quedaron sin reintentos (rate limit persistente, error del
 *    provider, etc). enqueueJob les da presupuesto nuevo (attempts vuelve a 0).
 *  - status "generating" pero que NO estan corriendo de verdad: quedaron colgados
 *    (tipico si reiniciaste el server o hubo HMR). En la UI se ven "generando" para
 *    siempre. Solo se tocan si `includeStuck` (default true).
 *
 * `type` limita a imagenes o videos (asi "reintentar imagenes" no toca los clips).
 */
export function retryBrokenJobs(
  projectId: string,
  opts?: { type?: JobType; includeStuck?: boolean }
): string[] {
  const includeStuck = opts?.includeStuck !== false;
  const requeued: string[] = [];
  for (const job of jobsDb.byProject(projectId)) {
    if (opts?.type && job.type !== opts.type) continue;
    const broken =
      job.status === "failed" ||
      (includeStuck &&
        job.status === "generating" &&
        !state.running.has(job.id));
    if (!broken) continue;
    enqueueJob(job.id); // resetea attempts/retryAt, reactiva el proyecto y bombea
    requeued.push(job.id);
  }
  if (requeued.length > 0) {
    logEvent(
      projectId,
      "info",
      `Reintento manual de ${requeued.length} job(s) con error o colgados.`
    );
  }
  return requeued;
}

/**
 * Saca al proyecto COMPLETO del estado en memoria de la cola (se usa al borrar el
 * proyecto). No cancela requests ya en vuelo: los jobs que esten corriendo terminan,
 * pero al escribir en la DB no van a encontrar el registro y no se reencola nada.
 */
export function purgeProject(projectId: string): void {
  const jobIds = jobsDb.byProject(projectId).map((j) => j.id);
  state.activeProjects.delete(projectId);
  state.pausedProjects.delete(projectId);
  for (const id of jobIds) {
    state.running.delete(id);
    state.retryAt.delete(id);
  }
}

/**
 * True si la FASE del proyecto bloquea este job. En fase "images" los jobs de video
 * esperan aunque su imagen ya este aprobada: asi se puede revisar/aprobar todas las
 * imagenes sin que arranque un solo video (ni el gasto ni el rate limit de Veo).
 */
function isStageBlocked(job: JobRecord): boolean {
  if (job.type !== "video") return false;
  return projectsDb.get(job.projectId)?.stage === "images";
}

function runnableReason(job: JobRecord): "run" | "wait" | "dep-failed" {
  if (isStageBlocked(job)) return "wait";
  // Rate limit de video: si la ventana esta llena, este job espera su turno.
  if (job.type === "video" && videoRateWaitMs() > 0) return "wait";
  const base = depReason(job);
  if (base !== "run") return base;
  // Con auto-aprobacion no hay gate por lotes: la ventana de generacion la define
  // la concurrencia (p.ej. 3 a la vez, rolling). El gate solo aplica en modo manual.
  if (isProjectAutoApprove(job.projectId)) return "run";
  // Gate por LOTES (modo manual): no arrancamos mas de N jobs del MISMO tipo que
  // esten "sin aprobar" (generando + esperando aprobacion). El limite es por TIPO:
  // las imagenes van sin limite (se genera la tanda entera y se revisa en bloque) y
  // los videos de a 5, porque cada clip de Veo son varios USD. Ver config.pipeline.
  const limit = approvalBatchFor(job.type);
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

/** Tamaño del lote de aprobacion para un tipo de job (0 = sin limite). */
function approvalBatchFor(type: JobRecord["type"]): number {
  return type === "video"
    ? config.pipeline.approvalBatchVideos
    : config.pipeline.approvalBatchImages;
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
    // Recupera jobs colgados en "generating" (p.ej. tras reiniciar el server) antes
    // de decidir que correr.
    reconcileStuckJobs();
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
          // Si lo unico que frena es la ventana de rate limit de video, esperamos
          // exactamente lo que falta para el proximo slot en vez de sondear cada 500ms.
          const wait = videoRateWaitMs();
          const hasVideoPending = pending.some((j) => j.type === "video");
          setTimeout(() => pump(), hasVideoPending && wait > 0 ? wait + 100 : 500);
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
  // Anotamos el arranque para la ventana de rate limit de video.
  if (job.type === "video") state.videoStarts.push(Date.now());
  jobsDb.update(job.id, {
    status: "generating",
    attempts: job.attempts + 1,
    error: null,
  });

  void (async () => {
    try {
      await runJobGeneration(job);
      if (isProjectAutoApprove(job.projectId)) {
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
          requeueOrFail(
            job,
            `${
              isRateLimit ? "Rate limit (429)" : "Error de red"
            } persistente tras ${maxT} reintentos: ${message}`
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
        requeueOrFail(job, message);
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

    /**
     * Reintento con backoff YA PROGRAMADO (429 o red): el `setTimeout(pump)` que lo
     * va a levantar solo encuentra el job si el proyecto sigue ACTIVO. Si se
     * desactiva, el job queda colgado en "pending" para siempre.
     *
     * Esto tiene que evaluarse ANTES de la rama de `awaiting_approval`, porque esa
     * rama hace `activeProjects.delete()` y `continue`, y se saltea el chequeo de
     * pendientes que hay mas abajo (que ya documentaba este caso).
     *
     * El bug se veia asi, con auto-aprobacion apagada: de dos imagenes con 2
     * variantes, una terminaba y quedaba en awaiting_approval, la otra se comia un
     * 429 en su segunda variante y programaba el reintento a 45s. Como ya no habia
     * nada generando, finalizeProjects entraba por `awaiting`, desactivaba el
     * proyecto y esa segunda imagen se quedaba en 1/2 sin retomar NUNCA. La primera
     * si se recuperaba, pero solo porque la otra la mantenia viva mientras generaba.
     */
    const conReintentoProgramado = jobs.some(
      (j) => j.status === "pending" && (state.retryAt.get(j.id) ?? 0) > Date.now()
    );

    const awaiting = jobs.some((j) => j.status === "awaiting_approval");
    if (awaiting) {
      projectsDb.update(projectId, { status: "review" });
      /**
       * Aviso de "aproba el lote para que siga".
       *
       * Se busca un pendiente que este frenado EXACTAMENTE por el gate de lotes de su
       * tipo, en vez de mirar si hay algun pendiente y listo. Un pendiente puede estar
       * esperando por otras cuatro razones (dependencia sin aprobar, la fase "images"
       * frenando los videos, backoff de un 429, rate limit de Veo) y en esos casos el
       * aviso mandaba a aprobar algo que no iba a desbloquear nada.
       *
       * Ademas el limite ahora es por tipo, asi que el numero del mensaje sale del
       * tipo realmente frenado y no de una constante global.
       */
      const frenadoPorLote = jobs.find(
        (j) =>
          j.status === "pending" &&
          approvalBatchFor(j.type) > 0 &&
          !isStageBlocked(j) &&
          depReason(j) === "run" &&
          inFlightUnapproved(projectId, j.type) >= approvalBatchFor(j.type)
      );
      if (frenadoPorLote && !conReintentoProgramado) {
        const limite = approvalBatchFor(frenadoPorLote.type);
        const tipo = frenadoPorLote.type === "video" ? "clips" : "imágenes";
        const enEspera = jobs.filter(
          (j) => j.type === frenadoPorLote.type && j.status === "awaiting_approval"
        ).length;
        logEvent(
          projectId,
          "info",
          `Lote de ${enEspera} ${tipo} listo. Aprobalos para seguir generando el resto (de a ${limite}).`
        );
      }
      // Solo se desactiva si NO hay un reintento esperando. Si hay, el proyecto
      // queda activo aunque haya jobs esperando aprobacion: el usuario puede
      // aprobar mientras el reintento sigue su curso en paralelo.
      if (!conReintentoProgramado) {
        state.activeProjects.delete(projectId); // se re-activa al aprobar/regenerar
      }
      void refreshManifest(projectId);
      continue;
    }

    // Quedan jobs PENDIENTES que no pueden correr ahora mismo. Dos casos:
    //  - la fase "images" esta frenando los videos -> el proyecto no esta terminado,
    //    queda esperando que el usuario pase a fase videos (lo sacamos de la cola).
    //  - un reintento con backoff programado -> hay que seguir ACTIVO, si no el
    //    setTimeout(pump) no lo encuentra y el job queda colgado en pending.
    const pending = jobs.filter((j) => j.status === "pending");
    if (pending.length > 0) {
      projectsDb.update(projectId, { status: "review" });
      if (pending.every((j) => isStageBlocked(j))) {
        state.activeProjects.delete(projectId); // se reactiva al pasar de fase
      }
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
