/**
 * GET /api/projects/:id/jobs
 * Devuelve el estado en vivo de todos los jobs + estado del proyecto + manifest.
 * Pensado para polling desde la UI del pipeline.
 */
import { jobsDb, projectsDb } from "@/lib/db";
import { buildManifest } from "@/lib/storage";
import { queueSnapshot } from "@/lib/jobs/queue";
import { notFound, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const project = projectsDb.get(params.id);
  if (!project) return notFound("Proyecto no encontrado");
  const jobs = jobsDb.byProject(project.id);
  return ok({
    projectStatus: project.status,
    jobs,
    manifest: buildManifest(project, jobs),
    queue: queueSnapshot(),
  });
}
