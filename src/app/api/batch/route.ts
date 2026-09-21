/**
 * GET  /api/batch?ids=a,b,c   -> estado del lote (tablero + cola de revision de imagenes)
 * POST /api/batch             -> acciones sobre TODO el lote:
 *      { ids, action: "start-images" | "start-videos" | "pause" | "resume" }
 *
 * "start-images"/"start-videos": deja cada proyecto en la fase correspondiente y los
 * arranca de a UNO (startBatch/notifyProjectFinished, jobs/masivo.ts), NUNCA los N
 * juntos con enqueueProject.
 *
 * Antes se hacia enqueueProject(project.id) por cada proyecto del lote, todos de una.
 * La concurrencia de la cola es GLOBAL (PIPELINE_CONCURRENCY, default 3) pero eso no
 * limita cuantos jobs quedan "pending" disponibles para llenar esos slots: con 30
 * proyectos en el tablero, apenas termina un job entra el de OTRO proyecto a ocupar
 * el slot, y la cola sostiene 3 requests simultaneas contra el mismo modelo sin
 * pausa mientras haya trabajo de cualquier proyecto. Eso es lo que dispara el 429 en
 * cascada: el backoff de rate limit tiene presupuesto de 10 reintentos aparte de los
 * intentos normales, y con 30 proyectos empujando a la vez se agotan y el job queda
 * "failed" en vez de esperar su turno. El generador masivo (/imagenes, pestaña
 * "Generador masivo") ya resolvia esto mismo corriendo un proyecto a la vez; se reusa
 * el mismo mecanismo aca en vez de inventar uno nuevo.
 */
import { jobsDb, projectsDb } from "@/lib/db";
import { buildBatchSnapshot } from "@/lib/batch";
import { approveJob, buildJobs } from "@/lib/jobs/pipeline";
import {
  enqueueProject,
  pauseProject,
  resumeProject,
  retryBrokenJobs,
} from "@/lib/jobs/queue";
import { startBatch } from "@/lib/jobs/masivo";
import { ensureProjectDirs, writeManifest } from "@/lib/storage";
import { filterOwnedIds } from "@/lib/ownership";
import { badRequest, ok, serverError } from "@/lib/http";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseIds(raw: string | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export async function GET(req: Request) {
  try {
    const ids = parseIds(new URL(req.url).searchParams.get("ids"));
    // Filtra en vez de rechazar (D6 del plan de aislamiento): un tablero son varios
    // proyectos a la vez, y si un solo id ajeno tirara 404 en todo el request, pegar
    // una URL vieja con un id de mas romperia el tablero entero en vez de mostrar los
    // que si son tuyos. Los rechazados (ajenos O inexistentes, mezclados a proposito
    // para no filtrar cual es cual — D4) se suman a missingIds, que la UI ya renderiza.
    const { owned, rejected } = filterOwnedIds(ids);
    const snap = buildBatchSnapshot(owned);
    return ok({ ...snap, missingIds: [...snap.missingIds, ...rejected] });
  } catch (err) {
    return serverError(err);
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      ids?: string[];
      action?:
        | "start-images"
        | "start-videos"
        | "pause"
        | "resume"
        | "retry-images"
        | "retry-videos"
        | "approve-videos";
      /**
       * Solo para "start-videos": si los clips se aprueban solos al terminar.
       * Default FALSE: cada clip queda esperando tu aprobacion, asi los revisás de
       * a uno (y podés editar prompt/dialogo antes de regenerar). Mandá true para
       * dejarlo correr sin aprobar nada.
       */
      autoApproveVideos?: boolean;
    };
    const ids = (body.ids ?? []).filter(Boolean);
    const action = body.action;
    if (ids.length === 0) return badRequest("Faltan los ids del lote.");
    if (!action) return badRequest("Falta la accion.");

    // Filtra ANTES de ejecutar nada: si el loop iterara sobre `ids` del body en vez
    // de `owned`, la accion (aprobar, regenerar, cambiar de fase) se ejecutaria sobre
    // proyectos ajenos aunque la respuesta despues los filtrara. El daño ya estaria
    // hecho (D6 del plan de aislamiento).
    const { owned, rejected } = filterOwnedIds(ids);

    const applied: string[] = [];
    const requeued: string[] = [];
    // Ids de start-images/start-videos que quedan listos para arrancar. Se acumulan
    // en el loop y se encolan de a UNO al final (startBatch), en vez de
    // enqueueProject por cada uno: ver el comentario del header sobre el 429 en
    // cascada que causaba arrancar los N juntos.
    const toStart: string[] = [];
    for (const id of owned) {
      const project = projectsDb.get(id);
      if (!project) continue;

      // Reintentar lo roto: jobs "failed" + los colgados en "generating" que en
      // realidad no estan corriendo (quedan asi si se reinicio el server).
      if (action === "retry-images" || action === "retry-videos") {
        const done = retryBrokenJobs(project.id, {
          type: action === "retry-images" ? "image" : "video",
        });
        requeued.push(...done);
        if (done.length > 0) applied.push(project.id);
        continue;
      }

      // Aprobar de una todos los clips que esperan aprobacion.
      if (action === "approve-videos") {
        const awaiting = jobsDb
          .byProject(project.id)
          .filter((j) => j.type === "video" && j.status === "awaiting_approval");
        for (const j of awaiting) {
          await approveJob(j.id);
          requeued.push(j.id);
        }
        if (awaiting.length > 0) {
          applied.push(project.id);
          enqueueProject(project.id); // desbloquea lo que dependa y sigue
        }
        continue;
      }

      if (action === "pause") {
        pauseProject(project.id);
        applied.push(project.id);
        continue;
      }
      if (action === "resume") {
        resumeProject(project.id);
        applied.push(project.id);
        continue;
      }

      const stage = action === "start-images" ? "images" : "videos";
      // Aprobacion MANUAL por defecto en las dos fases: la revision de a uno es el
      // punto del lote. Solo se auto-aprueban los videos si lo pedis explicitamente.
      const updated =
        projectsDb.update(project.id, {
          stage,
          autoApprove:
            stage === "images" ? false : body.autoApproveVideos === true,
        }) ?? project;

      await ensureProjectDirs(updated.id);
      const jobs = buildJobs(updated); // idempotente: no rehace lo aprobado
      await writeManifest(updated, jobs);
      toStart.push(updated.id);
      applied.push(updated.id);
    }

    // Arranca el lote de a UNO: startBatch encola solo toStart[0]; jobs/masivo.ts
    // (notifyProjectFinished, enganchado en queue.ts/finalizeProjects) encola el
    // siguiente en cuanto el anterior deja de necesitar la cola: llega a
    // done/partial/failed, O se frena esperando aprobacion (modo manual, el default
    // de start-images/start-videos) sin nada mas que pueda generarse solo. Un
    // batchId nuevo por request: no hay que recordarlo despues, notifyProjectFinished
    // lo desarma solo cuando el ultimo proyecto de la lista termina.
    if (toStart.length > 0) {
      startBatch(randomUUID(), toStart, enqueueProject);
    }

    const batch = buildBatchSnapshot(owned);
    return ok({
      action,
      applied,
      requeued: requeued.length,
      batch: { ...batch, missingIds: [...batch.missingIds, ...rejected] },
    });
  } catch (err) {
    return serverError(err);
  }
}
