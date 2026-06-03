/**
 * POST /api/projects/:id/regenerate-batch
 * Regenera SOLO los jobs indicados (los que marcaste como malos), sin tocar el resto.
 * Body: { jobIds?: string[], refIds?: string[] }
 *   - jobIds: ids completos de job (ej "proj:vid:hook").
 *   - refIds: ids de clip/imagen (ej "hook"); se resuelven a su job del proyecto.
 * Cada job se reencola (queda pending -> se regenera y, con auto-aprobacion, se aprueba solo).
 */
import { jobsDb, projectsDb } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs/queue";
import { badRequest, notFound, ok, serverError } from "@/lib/http";

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
      jobIds?: string[];
      refIds?: string[];
    };

    const projectJobs = jobsDb.byProject(project.id);
    const byId = new Map(projectJobs.map((j) => [j.id, j]));
    const byRef = new Map(projectJobs.map((j) => [j.refId, j]));

    const ids = new Set<string>();
    for (const jid of body.jobIds ?? []) {
      if (byId.has(jid)) ids.add(jid);
    }
    for (const rid of body.refIds ?? []) {
      const j = byRef.get(rid);
      if (j) ids.add(j.id);
    }

    if (ids.size === 0) {
      return badRequest("No se indico ningun job valido para regenerar.");
    }

    for (const jid of ids) enqueueJob(jid);

    return ok({ regenerated: ids.size, jobIds: Array.from(ids) });
  } catch (err) {
    return serverError(err);
  }
}
