/**
 * GET    /api/projects/:id   -> proyecto + jobs + manifest + estimacion
 * PUT    /api/projects/:id   -> actualiza plan / nombre / modelos / variantes
 * DELETE /api/projects/:id   -> elimina proyecto y sus jobs (no borra archivos en disco)
 */
import { jobsDb, projectsDb } from "@/lib/db";
import { validatePlan } from "@/lib/schema";
import { resolveModel, resolveResolution } from "@/lib/config";
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
    estimate: estimateCost(project.plan, project.imageVariants),
  });
}

export async function PUT(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const project = projectsDb.get(params.id);
    if (!project) return notFound("Proyecto no encontrado");

    const body = (await req.json()) as {
      name?: string;
      plan?: unknown;
      models?: { llm?: string; image?: string; video?: string };
      imageVariants?: number;
      defaultResolution?: string;
    };

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
    if (body.models !== undefined) {
      projectsDb.update(project.id, {
        models: {
          llm: resolveModel("llm", body.models.llm ?? project.models.llm),
          image: resolveModel("image", body.models.image ?? project.models.image),
          video: resolveModel("video", body.models.video ?? project.models.video),
        },
      });
    }
    if (body.imageVariants !== undefined) {
      projectsDb.update(project.id, {
        imageVariants: Math.min(4, Math.max(1, body.imageVariants)),
      });
    }
    if (body.defaultResolution !== undefined) {
      projectsDb.update(project.id, {
        defaultResolution: resolveResolution(body.defaultResolution),
      });
    }

    const updated = projectsDb.get(project.id)!;
    buildJobs(updated);
    await writeManifest(updated, jobsDb.byProject(updated.id));

    return ok({
      project: updated,
      jobs: jobsDb.byProject(updated.id),
      estimate: estimateCost(updated.plan, updated.imageVariants),
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
