/**
 * Utilidades internas compartidas del pipeline: ids de jobs, lookup de imagenes,
 * logging y refresco del manifest. Lo usan el resto de los modulos de pipeline/.
 */
import { jobsDb, logsDb, projectsDb } from "../../db";
import { appendLogFile, writeManifest } from "../../storage";
import type { ProjectPlan } from "../../schema";
import type { LogEntry, LogLevel } from "../../types";

export function imageJobId(projectId: string, imageId: string): string {
  return `${projectId}:img:${imageId}`;
}
export function videoJobId(projectId: string, clipId: string): string {
  return `${projectId}:vid:${clipId}`;
}

/** Busca una imagen del plan por id, devolviendo su asset contenedor. */
export function findImage(plan: ProjectPlan, imageId: string) {
  for (const asset of plan.assets) {
    const img = asset.images.find((i) => i.id === imageId);
    if (img) return { asset, img };
  }
  return null;
}

/** Todos los ids de referencia de una imagen (ref_image_id + ref_image_ids), sin duplicados. */
export function imageRefIds(img: {
  ref_image_id?: string;
  ref_image_ids?: string[];
}): string[] {
  const set = new Set<string>();
  if (img.ref_image_id) set.add(img.ref_image_id);
  for (const r of img.ref_image_ids ?? []) set.add(r);
  return [...set];
}

/** Mime type aproximado a partir de la extension del archivo. */
export function guessImageMime(rel: string): string {
  const lower = rel.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/png";
}

/** Agrega una entrada al log del proyecto (en DB + pipeline.log best-effort). */
export function logEvent(
  projectId: string,
  level: LogLevel,
  message: string,
  extra?: { jobId?: string; model?: string }
): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    message,
    jobId: extra?.jobId,
    model: extra?.model,
  };
  logsDb.append(projectId, entry);
  appendLogFile(
    projectId,
    `[${entry.ts}] ${level.toUpperCase()} ${extra?.jobId ?? ""} ${
      extra?.model ? `(${extra.model})` : ""
    } ${message}`.replace(/\s+/g, " ")
  );
}

/** Reescribe el manifest.json del proyecto con el estado actual de los jobs. */
export async function refreshManifest(projectId: string): Promise<void> {
  const project = projectsDb.get(projectId);
  if (!project) return;
  await writeManifest(project, jobsDb.byProject(projectId));
}
