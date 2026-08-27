/**
 * GET  /api/batch?ids=a,b,c   -> estado del lote (tablero + cola de revision de imagenes)
 * POST /api/batch             -> acciones sobre TODO el lote:
 *      { ids, action: "start-images" | "start-videos" | "pause" | "resume" }
 *
 * "start-images": deja cada proyecto en fase imagenes con auto-aprobacion APAGADA
 * (si no, no habria nada que revisar) y encola. Los videos NO arrancan hasta
 * "start-videos". La concurrencia de la cola es global, asi que arrancar 5 proyectos
 * juntos genera el mismo rate de requests que arrancar uno.
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
import { ensureProjectDirs, writeManifest } from "@/lib/storage";
import { badRequest, ok, serverError } from "@/lib/http";

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
    return ok(buildBatchSnapshot(ids));
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

    const applied: string[] = [];
    const requeued: string[] = [];
    for (const id of ids) {
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
      enqueueProject(updated.id);
      applied.push(updated.id);
    }

    return ok({
      action,
      applied,
      requeued: requeued.length,
      batch: buildBatchSnapshot(ids),
    });
  } catch (err) {
    return serverError(err);
  }
}
