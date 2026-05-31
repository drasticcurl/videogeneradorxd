/**
 * Capa de almacenamiento LOCAL en filesystem.
 *
 * Estructura por proyecto:
 *   ./output/<project_id>/
 *     images/<image_id>.png              (imagen aprobada/elegida)
 *     images/_candidates/<id>__vN.png    (candidatos antes de aprobar)
 *     clips/NN_<clip>.mp4
 *     manifest.json
 *     pipeline.log
 *     final.mp4                          (opcional, si se hace stitch con ffmpeg)
 *
 * NADA se sube a servicios externos.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import type { JobRecord, Manifest, ProjectRecord } from "./types";

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "item"
  );
}

export function projectDir(projectId: string): string {
  return path.join(config.storage.outputDir, projectId);
}
export function imagesDir(projectId: string): string {
  return path.join(projectDir(projectId), "images");
}
export function clipsDir(projectId: string): string {
  return path.join(projectDir(projectId), "clips");
}

export async function ensureProjectDirs(projectId: string): Promise<void> {
  await fsp.mkdir(path.join(imagesDir(projectId), "_candidates"), {
    recursive: true,
  });
  await fsp.mkdir(clipsDir(projectId), { recursive: true });
}

/** Imagen aprobada/canonica relativa a la carpeta del proyecto. */
export function imageRelPath(imageId: string, ext = "png"): string {
  return path.posix.join("images", `${slugify(imageId)}.${ext}`);
}

/** Candidato de imagen (antes de aprobar). */
export function candidateRelPath(
  imageId: string,
  index: number,
  ext = "png"
): string {
  return path.posix.join(
    "images",
    "_candidates",
    `${slugify(imageId)}__v${index}.${ext}`
  );
}

/** Nombre de archivo de clip: NN_<slug>.mp4 (ordenado por "orden"). */
export function clipRelPath(orden: number, clipId: string): string {
  const nn = String(orden).padStart(2, "0");
  return path.posix.join("clips", `${nn}_${slugify(clipId)}.mp4`);
}

export async function saveBytes(
  projectId: string,
  relPath: string,
  bytes: Uint8Array
): Promise<string> {
  const abs = path.join(projectDir(projectId), relPath);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, bytes);
  return relPath;
}

export async function readBytes(
  projectId: string,
  relPath: string
): Promise<Uint8Array> {
  const abs = path.join(projectDir(projectId), relPath);
  return fsp.readFile(abs);
}

export async function copyWithin(
  projectId: string,
  fromRel: string,
  toRel: string
): Promise<string> {
  const fromAbs = path.join(projectDir(projectId), fromRel);
  const toAbs = path.join(projectDir(projectId), toRel);
  await fsp.mkdir(path.dirname(toAbs), { recursive: true });
  await fsp.copyFile(fromAbs, toAbs);
  return toRel;
}

export async function removeRel(projectId: string, relPath: string): Promise<void> {
  try {
    await fsp.unlink(path.join(projectDir(projectId), relPath));
  } catch {
    /* ignore */
  }
}

export function absPathFor(projectId: string, relPath: string): string {
  return path.join(projectDir(projectId), relPath);
}

export function existsRel(projectId: string, relPath: string): boolean {
  return fs.existsSync(absPathFor(projectId, relPath));
}

/**
 * Resuelve de forma SEGURA un path relativo dentro de output/<projectId>/
 * (previene path traversal). Devuelve null si el path escapa la carpeta.
 */
export function safeResolve(projectId: string, relPath: string): string | null {
  const base = projectDir(projectId);
  const target = path.normalize(path.join(base, relPath));
  if (target !== base && !target.startsWith(base + path.sep)) {
    return null;
  }
  return target;
}

/* --------------------------- Manifest --------------------------- */

export function buildManifest(
  project: ProjectRecord,
  jobs: JobRecord[]
): Manifest {
  const imageJobByRef = new Map<string, JobRecord>();
  const videoJobByRef = new Map<string, JobRecord>();
  for (const j of jobs) {
    if (j.type === "image") imageJobByRef.set(j.refId, j);
    else videoJobByRef.set(j.refId, j);
  }

  const images: Manifest["images"] = [];
  for (const asset of project.plan.assets) {
    for (const img of asset.images) {
      const job = imageJobByRef.get(img.id);
      images.push({
        id: img.id,
        asset_id: asset.id,
        modo: img.modo,
        ref_image_id: img.ref_image_id,
        prompt: img.prompt,
        status: job?.status ?? "pending",
        file: job?.outputPath ?? null,
        model: job?.model ?? null,
      });
    }
  }

  const clips: Manifest["clips"] = project.plan.clips
    .slice()
    .sort((a, b) => a.orden - b.orden)
    .map((clip) => {
      if (clip.etiqueta === "FILMAR_REAL") {
        const rel = clipRelPath(clip.orden, clip.id);
        const exists = existsRel(project.id, rel);
        return {
          id: clip.id,
          orden: clip.orden,
          asset_id: clip.asset_id,
          image_id: clip.image_id,
          etiqueta: clip.etiqueta,
          dialogo: clip.dialogo,
          duracion_seg: clip.duracion_seg,
          on_screen_text: clip.on_screen_text,
          status: exists ? "done" : "placeholder",
          file: exists ? rel : null,
          model: null,
        };
      }
      const job = videoJobByRef.get(clip.id);
      return {
        id: clip.id,
        orden: clip.orden,
        asset_id: clip.asset_id,
        image_id: clip.image_id,
        etiqueta: clip.etiqueta,
        dialogo: clip.dialogo,
        duracion_seg: clip.duracion_seg,
        on_screen_text: clip.on_screen_text,
        status: job?.status ?? "pending",
        file: job?.outputPath ?? null,
        model: job?.model ?? null,
      };
    });

  const finalRel = "final.mp4";
  const finalExists = existsRel(project.id, finalRel);

  return {
    project_id: project.id,
    name: project.name,
    created_at: project.createdAt,
    updated_at: new Date().toISOString(),
    provider_mode: config.providerMode,
    models: project.models,
    global: project.plan.global,
    images,
    clips,
    final_video: finalExists ? finalRel : null,
    warnings: project.plan.warnings ?? [],
  };
}

export async function writeManifest(
  project: ProjectRecord,
  jobs: JobRecord[]
): Promise<Manifest> {
  await ensureProjectDirs(project.id);
  const manifest = buildManifest(project, jobs);
  const abs = absPathFor(project.id, "manifest.json");
  await fsp.writeFile(abs, JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

/** Agrega una linea al pipeline.log del proyecto (best-effort). */
export function appendLogFile(
  projectId: string,
  line: string
): void {
  try {
    const abs = absPathFor(projectId, "pipeline.log");
    fs.mkdirSync(projectDir(projectId), { recursive: true });
    fs.appendFileSync(abs, line + "\n", "utf8");
  } catch {
    /* best-effort */
  }
}
