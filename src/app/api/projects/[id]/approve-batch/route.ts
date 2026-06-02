/**
 * POST /api/projects/:id/approve-batch
 * Aprueba DE UNA todos los jobs que estan esperando aprobacion (el lote actual).
 * Body opcional: { type?: "image" | "video" } para aprobar solo imagenes o solo videos.
 * Tras aprobar, re-encola el proyecto: el gate por lotes deja pasar el proximo lote.
 */
import { jobsDb, projectsDb } from "@/lib/db";
import { approveJob } from "@/lib/jobs/pipeline";
import { enqueueProject } from "@/lib/jobs/queue";
import { notFound, ok, serverError } from "@/lib/http";

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
      type?: "image" | "video";
    };

    const awaiting = jobsDb
      .byProject(project.id)
      .filter(
        (j) =>
          j.status === "awaiting_approval" &&
          (!body.type || j.type === body.type)
      );

    let approved = 0;
    for (const j of awaiting) {
      // approveJob usa selectedIndex / primer candidato para imagenes con variantes.
      await approveJob(j.id);
      approved++;
    }

    // Re-encola una sola vez para continuar con el proximo lote.
    enqueueProject(project.id);

    return ok({ approved });
  } catch (err) {
    return serverError(err);
  }
}
