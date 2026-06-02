/**
 * POST /api/projects/:id/references
 * Sube una FOTO/AVATAR de referencia (VSL) al proyecto.
 * Form-data: { referenceId: string, file: File, label?: string }
 * Guarda el archivo en references/<referenceId>.<ext> y actualiza plan.references[].file.
 * Esa foto es la fuente de identidad para todos los planos image2image de esa persona.
 *
 * GET /api/projects/:id/references -> lista las referencias del proyecto (id, label, file, status).
 */
import { jobsDb, projectsDb } from "@/lib/db";
import { buildJobs } from "@/lib/jobs/pipeline";
import {
  buildManifest,
  ensureProjectDirs,
  referenceRelPath,
  saveBytes,
  slugify,
  writeManifest,
} from "@/lib/storage";
import type { ProjectPlan } from "@/lib/schema";
import { badRequest, notFound, ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

function extFor(file: File): string {
  const byMime = MIME_EXT[file.type];
  if (byMime) return byMime;
  const name = file.name ?? "";
  const dot = name.lastIndexOf(".");
  if (dot >= 0) {
    const ext = name.slice(dot + 1).toLowerCase();
    if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) {
      return ext === "jpeg" ? "jpg" : ext;
    }
  }
  return "png";
}

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const project = projectsDb.get(params.id);
  if (!project) return notFound("Proyecto no encontrado");
  const manifest = buildManifest(project, jobsDb.byProject(project.id));
  return ok({ references: manifest.references });
}

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const project = projectsDb.get(params.id);
    if (!project) return notFound("Proyecto no encontrado");

    const form = await req.formData();
    const referenceId = slugify(String(form.get("referenceId") ?? ""));
    const label = form.get("label");
    const file = form.get("file");

    if (!referenceId) return badRequest("Falta referenceId.");
    if (!(file instanceof File)) return badRequest("Falta el archivo (file).");

    await ensureProjectDirs(project.id);
    const ext = extFor(file);
    const relPath = referenceRelPath(referenceId, ext);
    const bytes = new Uint8Array(await file.arrayBuffer());
    await saveBytes(project.id, relPath, bytes);

    // Actualizamos (o creamos) la entrada en plan.references con el archivo recien subido.
    const plan: ProjectPlan = {
      ...project.plan,
      references: [...(project.plan.references ?? [])],
    };
    const idx = plan.references.findIndex((r) => r.id === referenceId);
    const entry = {
      id: referenceId,
      label:
        (typeof label === "string" && label) ||
        (idx >= 0 ? plan.references[idx].label : undefined),
      file: relPath,
    };
    if (idx >= 0) plan.references[idx] = entry;
    else plan.references.push(entry);

    projectsDb.update(project.id, { plan });

    // Reconstruimos jobs (las dependencias pueden cambiar) y refrescamos manifest.
    const updated = projectsDb.get(project.id)!;
    buildJobs(updated);
    await writeManifest(updated, jobsDb.byProject(updated.id));

    return ok({ uploaded: true, referenceId, file: relPath });
  } catch (err) {
    return serverError(err);
  }
}
