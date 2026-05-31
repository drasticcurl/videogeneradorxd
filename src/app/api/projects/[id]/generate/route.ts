/**
 * POST /api/projects/:id/generate
 * Construye los jobs del pipeline y los encola (asincrono). Devuelve los jobs creados.
 * El frontend luego hace polling a /jobs.
 */
import { jobsDb, projectsDb } from "@/lib/db";
import { buildJobs } from "@/lib/jobs/pipeline";
import { enqueueProject } from "@/lib/jobs/queue";
import { ensureProjectDirs, writeManifest } from "@/lib/storage";
import { notFound, ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const project = projectsDb.get(params.id);
    if (!project) return notFound("Proyecto no encontrado");

    await ensureProjectDirs(project.id);
    const jobs = buildJobs(project);
    await writeManifest(project, jobs);

    enqueueProject(project.id);

    return ok({ started: true, jobs: jobsDb.byProject(project.id) });
  } catch (err) {
    return serverError(err);
  }
}
