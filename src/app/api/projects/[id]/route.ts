/**
 * GET    /api/projects/:id   -> proyecto + jobs + manifest + estimacion
 * PUT    /api/projects/:id   -> actualiza plan / nombre / modelos / variantes
 * DELETE /api/projects/:id   -> elimina proyecto, sus jobs Y la carpeta output/<id>/
 *                               (usar ?keepFiles=1 para conservar los archivos)
 */
import { jobsDb, projectsDb } from "@/lib/db";
import { validatePlan } from "@/lib/schema";
import { resolveModel, resolveResolution } from "@/lib/config";
import { buildManifest, removeProjectDir, writeManifest } from "@/lib/storage";
import { purgeProject } from "@/lib/jobs/queue";
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

/**
 * Borra el proyecto por completo:
 *  - lo saca del estado en memoria de la cola (no se reencola nada),
 *  - borra el registro + sus jobs + sus logs de data/db.json,
 *  - borra la carpeta output/<id>/ ENTERA (imagenes, clips, referencias, video unido).
 *
 * Con ?keepFiles=1 se conserva la carpeta en disco (solo limpia la DB).
 */
export async function DELETE(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const project = projectsDb.get(params.id);
    if (!project) return notFound("Proyecto no encontrado");

    const keepFiles =
      new URL(req.url).searchParams.get("keepFiles") === "1";

    // 1) Cortamos la cola primero: si el pipeline estaba corriendo, dejamos de
    //    tomar jobs nuevos de este proyecto antes de borrar los archivos.
    purgeProject(project.id);

    // 2) Archivos en disco (imagenes + videos). Si falla, avisamos pero igual
    //    limpiamos la DB para que el proyecto no quede fantasma en la lista.
    let filesDeleted = false;
    let filesError: string | null = null;
    if (!keepFiles) {
      try {
        filesDeleted = await removeProjectDir(project.id);
      } catch (err) {
        filesError = err instanceof Error ? err.message : String(err);
      }
    }

    // 3) DB: proyecto + jobs + logs.
    projectsDb.remove(project.id);

    return ok({ deleted: true, filesDeleted, filesError });
  } catch (err) {
    return serverError(err);
  }
}
