/**
 * POST /api/projects/:id/upload
 * Subida MANUAL del archivo de un clip FILMAR_REAL.
 * Form-data: { clipId: string, file: File }
 * Guarda el archivo en clips/NN_<clip>.mp4 dentro de la carpeta del proyecto.
 */
import { jobsDb, projectsDb } from "@/lib/db";
import { clipRelPath, saveBytes, writeManifest } from "@/lib/storage";
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

    const form = await req.formData();
    const clipId = String(form.get("clipId") ?? "");
    const file = form.get("file");

    if (!clipId) return badRequest("Falta clipId.");
    if (!(file instanceof File)) return badRequest("Falta el archivo (file).");

    const clip = project.plan.clips.find((c) => c.id === clipId);
    if (!clip) return badRequest(`El clip "${clipId}" no existe en el plan.`);

    const bytes = new Uint8Array(await file.arrayBuffer());
    const relPath = clipRelPath(clip.orden, clip.id);
    await saveBytes(project.id, relPath, bytes);

    await writeManifest(project, jobsDb.byProject(project.id));

    return ok({ uploaded: true, file: relPath });
  } catch (err) {
    return serverError(err);
  }
}
