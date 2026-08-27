/**
 * POST /api/projects/:id/stage
 * Cambia la FASE del proyecto: { stage: "images" | "videos" | null }.
 *
 *  - "images": la cola solo corre imagenes (los videos esperan aunque su imagen
 *    este aprobada). Ideal para revisar/aprobar todo sin gastar Veo.
 *  - "videos": libera los videos y encola.
 *  - null: saca la fase (corre todo, comportamiento historico).
 */
import { projectsDb } from "@/lib/db";
import { enqueueProject } from "@/lib/jobs/queue";
import { logEvent } from "@/lib/jobs/pipeline";
import { badRequest, notFound, ok, serverError } from "@/lib/http";
import type { ProjectStage } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const project = projectsDb.get(params.id);
    if (!project) return notFound("Proyecto no encontrado");

    const body = (await req.json().catch(() => ({}))) as {
      stage?: ProjectStage | null;
    };
    const stage = body.stage ?? null;
    if (stage !== null && stage !== "images" && stage !== "videos") {
      return badRequest('stage tiene que ser "images", "videos" o null.');
    }

    const updated = projectsDb.update(project.id, {
      stage: stage ?? undefined,
    });
    logEvent(
      project.id,
      "info",
      stage === "images"
        ? "Fase IMAGENES: los videos quedan frenados hasta que pases de fase."
        : stage === "videos"
        ? "Fase VIDEOS: se liberan los clips para generar."
        : "Fase libre: corre todo."
    );
    // Al liberar los videos (o la fase) hay que volver a bombear la cola.
    if (stage !== "images") enqueueProject(project.id);

    return ok({ project: updated });
  } catch (err) {
    return serverError(err);
  }
}
