/**
 * GET /api/projects/:id/jobs
 * Estado en vivo de jobs + estado del proyecto + manifest + LOGS. Para polling de la UI.
 */
import { jobsDb, logsDb, projectsDb } from "@/lib/db";
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
    logs: logsDb.byProject(project.id).slice(-200),
    queue: queueSnapshot(),
  });
}
