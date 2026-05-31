/**
 * Construccion y ejecucion de jobs del pipeline.
 *
 * Cadena:
 *   1. imagenes text2image (sin dependencias)
 *   2. imagenes image2image (dependen de su ref_image_id ya generada)
 *   3. videos IA (dependen de la imagen image_id ya generada)
 *   - clips FILMAR_REAL no generan job (placeholders para subir a mano).
 */
import { config } from "../config";
import { jobsDb, projectsDb } from "../db";
import { getImageProvider, getVideoProvider } from "../providers";
import {
  clipRelPath,
  imageRelPath,
  readBytes,
  saveBytes,
  writeManifest,
} from "../storage";
import type { ProjectPlan } from "../schema";
import type { JobRecord, ProjectRecord } from "../types";

export function imageJobId(projectId: string, imageId: string): string {
  return `${projectId}:img:${imageId}`;
}
export function videoJobId(projectId: string, clipId: string): string {
  return `${projectId}:vid:${clipId}`;
}

function findImage(plan: ProjectPlan, imageId: string) {
  for (const asset of plan.assets) {
    const img = asset.images.find((i) => i.id === imageId);
    if (img) return { asset, img };
  }
  return null;
}

/** Crea (o re-crea) los jobs de un proyecto a partir de su plan. Idempotente por id. */
export function buildJobs(project: ProjectRecord): JobRecord[] {
  const now = new Date().toISOString();
  const existing = new Map(
    jobsDb.byProject(project.id).map((j) => [j.id, j])
  );
  const jobs: JobRecord[] = [];

  // Jobs de imagen.
  for (const asset of project.plan.assets) {
    for (const img of asset.images) {
      const id = imageJobId(project.id, img.id);
      const dependsOn =
        img.modo === "image2image" && img.ref_image_id
          ? imageJobId(project.id, img.ref_image_id)
          : null;
      const prev = existing.get(id);
      jobs.push({
        id,
        projectId: project.id,
        type: "image",
        refId: img.id,
        label: img.id,
        dependsOn,
        status: prev?.status === "done" ? "done" : "pending",
        attempts: 0,
        maxAttempts: config.pipeline.maxAttempts,
        error: null,
        outputPath: prev?.outputPath ?? null,
        meta: {},
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      });
    }
  }

  // Jobs de video (solo IA).
  for (const clip of project.plan.clips) {
    if (clip.etiqueta !== "IA") continue;
    const id = videoJobId(project.id, clip.id);
    const prev = existing.get(id);
    jobs.push({
      id,
      projectId: project.id,
      type: "video",
      refId: clip.id,
      label: `${String(clip.orden).padStart(2, "0")}_${clip.id}`,
      dependsOn: imageJobId(project.id, clip.image_id),
      status: prev?.status === "done" ? "done" : "pending",
      attempts: 0,
      maxAttempts: config.pipeline.maxAttempts,
      error: null,
      outputPath: prev?.outputPath ?? null,
      meta: {},
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    });
  }

  jobsDb.upsertMany(jobs);
  return jobs;
}

/** Ejecuta un job de imagen: genera y guarda en disco. */
async function runImageJob(job: JobRecord, project: ProjectRecord): Promise<string> {
  const found = findImage(project.plan, job.refId);
  if (!found) throw new Error(`Imagen "${job.refId}" no existe en el plan.`);
  const { img } = found;
  const aspectRatio = project.plan.global.formato || "9:16";
  const negativePrompt =
    img.negative_prompt || project.plan.global.negative_prompt || undefined;

  let refImageBytes: Uint8Array | undefined;
  let refImageMimeType: string | undefined;
  if (img.modo === "image2image" && img.ref_image_id) {
    const refJob = jobsDb.get(imageJobId(project.id, img.ref_image_id));
    if (!refJob || refJob.status !== "done" || !refJob.outputPath) {
      throw new Error(
        `La imagen de referencia "${img.ref_image_id}" todavia no esta lista.`
      );
    }
    refImageBytes = await readBytes(project.id, refJob.outputPath);
    refImageMimeType = "image/png";
  }

  const result = await getImageProvider().generate({
    prompt: img.prompt,
    refImageBytes,
    refImageMimeType,
    negativePrompt,
    aspectRatio,
  });

  const ext = result.mimeType.includes("jpeg") ? "jpg" : "png";
  const relPath = imageRelPath(img.id, ext);
  await saveBytes(project.id, relPath, result.bytes);
  return relPath;
}

/** Ejecuta un job de video: espera la imagen, genera con Veo y guarda. */
async function runVideoJob(job: JobRecord, project: ProjectRecord): Promise<string> {
  const clip = project.plan.clips.find((c) => c.id === job.refId);
  if (!clip) throw new Error(`Clip "${job.refId}" no existe en el plan.`);
  const aspectRatio = project.plan.global.formato || "9:16";

  const imgJob = jobsDb.get(imageJobId(project.id, clip.image_id));
  if (!imgJob || imgJob.status !== "done" || !imgJob.outputPath) {
    throw new Error(
      `La imagen "${clip.image_id}" del clip todavia no esta lista.`
    );
  }
  const imageBytes = await readBytes(project.id, imgJob.outputPath);

  const result = await getVideoProvider().generate({
    imageBytes,
    imageMimeType: "image/png",
    prompt: clip.video_prompt,
    durationSec: clip.duracion_seg,
    aspectRatio,
    dialogue: clip.dialogo,
  });

  const relPath = clipRelPath(clip.orden, clip.id);
  await saveBytes(project.id, relPath, result.bytes);
  return relPath;
}

/** Punto de entrada para ejecutar un job (lo usa la cola). Lanza si falla. */
export async function executeJob(job: JobRecord): Promise<string> {
  const project = projectsDb.get(job.projectId);
  if (!project) throw new Error(`Proyecto "${job.projectId}" no existe.`);
  if (job.type === "image") return runImageJob(job, project);
  return runVideoJob(job, project);
}

/** Reescribe el manifest del proyecto con el estado actual de los jobs. */
export async function refreshManifest(projectId: string): Promise<void> {
  const project = projectsDb.get(projectId);
  if (!project) return;
  await writeManifest(project, jobsDb.byProject(projectId));
}

/** Estimacion de cantidad de llamadas y costo aproximado (para la UI). */
export function estimateCost(plan: ProjectPlan) {
  const imageCount = plan.assets.reduce((acc, a) => acc + a.images.length, 0);
  const iaClips = plan.clips.filter((c) => c.etiqueta === "IA");
  const realClips = plan.clips.filter((c) => c.etiqueta === "FILMAR_REAL");
  const videoSeconds = iaClips.reduce((acc, c) => acc + c.duracion_seg, 0);

  const imageUsd = imageCount * config.pricing.imageUsd;
  const videoUsd = videoSeconds * config.pricing.videoPerSecUsd;
  const total = imageUsd + videoUsd;

  return {
    imageCount,
    videoCount: iaClips.length,
    realClipCount: realClips.length,
    videoSeconds,
    estimatedUsd: Number(total.toFixed(2)),
    breakdown: {
      imagesUsd: Number(imageUsd.toFixed(2)),
      videosUsd: Number(videoUsd.toFixed(2)),
    },
    providerMode: config.providerMode,
    note:
      config.providerMode === "mock"
        ? "PROVIDER_MODE=mock: no se gasta cuota ni dinero. La estimacion es solo ilustrativa."
        : "Estimacion aproximada; el costo real depende de los precios vigentes de Vertex AI.",
  };
}
