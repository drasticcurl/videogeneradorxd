/**
 * GET    /api/projects/:id   -> proyecto + jobs + manifest + estimacion
 * PUT    /api/projects/:id   -> actualiza el plan (edicion del JSON) y/o el nombre
 * DELETE /api/projects/:id   -> elimina proyecto y sus jobs (no borra archivos en disco)
 */
import { jobsDb, projectsDb } from "@/lib/db";
import { validatePlan } from "@/lib/schema";
import { buildManifest, writeManifest } from "@/lib/storage";
import { buildJobs, estimateCost } from "@/lib/jobs/pipeline";
import { badRequest, notFound, ok, serverError } from "@/lib/http";

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
    project,
    jobs,
    manifest: buildManifest(project, jobs),
    estimate: estimateCost(project.plan),
  });
}

export async function PUT(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const project = projectsDb.get(params.id);
    if (!project) return notFound("Proyecto no encontrado");

    const body = (await req.json()) as { name?: string; plan?: unknown };
    const patch: { name?: string; plan?: ReturnType<typeof validatePlan> } = {};

    if (body.plan !== undefined) {
      const validation = validatePlan(body.plan);
      if (!validation.ok) {
        return badRequest("El plan no es valido.", validation.errors);
      }
      projectsDb.update(project.id, { plan: validation.plan });
    }
    if (body.name !== undefined) {
      projectsDb.update(project.id, { name: body.name });
    }

    const updated = projectsDb.get(project.id)!;
    // Reconstruimos jobs (idempotente) y reescribimos manifest con el plan nuevo.
    buildJobs(updated);
    await writeManifest(updated, jobsDb.byProject(updated.id));

    return ok({
      project: updated,
      jobs: jobsDb.byProject(updated.id),
      estimate: estimateCost(updated.plan),
    });
  } catch (err) {
    return serverError(err);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const project = projectsDb.get(params.id);
  if (!project) return notFound("Proyecto no encontrado");
  projectsDb.remove(project.id);
  return ok({ deleted: true });
}
