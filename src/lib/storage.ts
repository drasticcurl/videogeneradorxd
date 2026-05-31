/**
 * Capa de almacenamiento LOCAL en filesystem.
 *
 * Estructura por proyecto:
 *   ./output/<project_id>/
 *     images/<image_id>.png
 *     clips/NN_<clip>.mp4
 *     manifest.json
 *     final.mp4            (opcional, si se hace stitch con ffmpeg)
 *
 * NADA se sube a servicios externos.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import type { JobRecord, Manifest, ProjectRecord } from "./types";

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "item";
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
  await fsp.mkdir(imagesDir(projectId), { recursive: true });
  await fsp.mkdir(clipsDir(projectId), { recursive: true });
}

/** Nombre de archivo de imagen relativo a la carpeta del proyecto. */
export function imageRelPath(imageId: string, ext = "png"): string {
  return path.posix.join("images", `${slugify(imageId)}.${ext}`);
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

export function absPathFor(projectId: string, relPath: string): string {
  return path.join(projectDir(projectId), relPath);
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
      });
    }
  }

  const clips: Manifest["clips"] = project.plan.clips
    .slice()
    .sort((a, b) => a.orden - b.orden)
    .map((clip) => {
      if (clip.etiqueta === "FILMAR_REAL") {
        // El placeholder puede tener un archivo subido manualmente.
        const rel = clipRelPath(clip.orden, clip.id);
        const exists = fs.existsSync(absPathFor(project.id, rel));
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
      };
    });

  const finalRel = "final.mp4";
  const finalExists = fs.existsSync(absPathFor(project.id, finalRel));

  return {
    project_id: project.id,
    name: project.name,
    created_at: project.createdAt,
    updated_at: new Date().toISOString(),
    provider_mode: config.providerMode,
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
