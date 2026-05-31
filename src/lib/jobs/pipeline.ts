/**
 * Construccion y ejecucion de jobs del pipeline + aprobacion + logging.
 *
 * Cadena (cada paso requiere APROBACION del usuario antes de desbloquear el siguiente):
 *   1. imagenes text2image (sin dependencias)
 *   2. imagenes image2image (dependen de su ref_image_id ya APROBADA)
 *   3. videos IA (dependen de la imagen image_id ya APROBADA) - con audio
 *   - clips FILMAR_REAL no generan job (placeholders para subir a mano).
 */
import path from "node:path";
import { config, ASPECT_RATIO, resolveResolution } from "../config";
import { jobsDb, logsDb, projectsDb } from "../db";
import { getImageProvider, getVideoProvider } from "../providers";
import {
  appendLogFile,
  candidateRelPath,
  clipRelPath,
  copyWithin,
  imageRelPath,
  readBytes,
  saveBytes,
  writeManifest,
} from "../storage";
import type { ProjectPlan } from "../schema";
import type { Candidate, JobRecord, LogEntry, LogLevel, ProjectRecord } from "../types";

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

/* ------------------------------ logging ------------------------------ */

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

/* ---------------------------- build jobs ----------------------------- */

/** Crea (o re-crea) los jobs de un proyecto a partir de su plan. Idempotente por id. */
export function buildJobs(project: ProjectRecord): JobRecord[] {
  const now = new Date().toISOString();
  const existing = new Map(jobsDb.byProject(project.id).map((j) => [j.id, j]));
  const jobs: JobRecord[] = [];

  const blank = (overrides: Partial<JobRecord>): JobRecord => ({
    id: "",
    projectId: project.id,
    type: "image",
    refId: "",
    label: "",
    dependsOn: null,
    status: "pending",
    attempts: 0,
    maxAttempts: config.pipeline.maxAttempts,
    error: null,
    outputPath: null,
    candidates: [],
    selectedIndex: null,
    variants: 1,
    locked: false,
    model: null,
    meta: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });

  // Jobs de imagen.
  for (const asset of project.plan.assets) {
    for (const img of asset.images) {
      const id = imageJobId(project.id, img.id);
      const dependsOn =
        img.modo === "image2image" && img.ref_image_id
          ? imageJobId(project.id, img.ref_image_id)
          : null;
      const prev = existing.get(id);
      // Preservamos lo ya aprobado/bloqueado.
      if (prev && (prev.locked || prev.status === "done")) {
        jobs.push({ ...prev, dependsOn, variants: project.imageVariants });
        continue;
      }
      jobs.push(
        blank({
          id,
          type: "image",
          refId: img.id,
          label: img.id,
          dependsOn,
          variants: project.imageVariants,
          status: prev?.status ?? "pending",
          candidates: prev?.candidates ?? [],
          createdAt: prev?.createdAt ?? now,
        })
      );
    }
  }

  // Jobs de video (solo IA).
  for (const clip of project.plan.clips) {
    if (clip.etiqueta !== "IA") continue;
    const id = videoJobId(project.id, clip.id);
    const prev = existing.get(id);
    if (prev && (prev.locked || prev.status === "done")) {
      jobs.push({
        ...prev,
        dependsOn: imageJobId(project.id, clip.image_id),
        label: `${String(clip.orden).padStart(2, "0")}_${clip.id}`,
      });
      continue;
    }
    jobs.push(
      blank({
        id,
        type: "video",
        refId: clip.id,
        label: `${String(clip.orden).padStart(2, "0")}_${clip.id}`,
        dependsOn: imageJobId(project.id, clip.image_id),
        variants: 1,
        status: prev?.status ?? "pending",
        createdAt: prev?.createdAt ?? now,
      })
    );
  }

  jobsDb.upsertMany(jobs);
  return jobs;
}

/* --------------------------- run generation -------------------------- */

/**
 * Ejecuta la generacion de un job (imagen o video). Guarda archivos y actualiza
 * candidates/outputPath/model en el job. NO fija el estado final: la cola lo pasa
 * a "awaiting_approval". Lanza si falla (la cola maneja reintentos/backoff).
 */
export async function runJobGeneration(job: JobRecord): Promise<void> {
  const project = projectsDb.get(job.projectId);
  if (!project) throw new Error(`Proyecto "${job.projectId}" no existe.`);
  if (job.type === "image") return runImageGeneration(job, project);
  return runVideoGeneration(job, project);
}

async function runImageGeneration(
  job: JobRecord,
  project: ProjectRecord
): Promise<void> {
  const found = findImage(project.plan, job.refId);
  if (!found) throw new Error(`Imagen "${job.refId}" no existe en el plan.`);
  const { img } = found;
  const model = project.models.image;
  const negativePrompt =
    img.negative_prompt || project.plan.global.negative_prompt || undefined;

  let refImageBytes: Uint8Array | undefined;
  if (img.modo === "image2image" && img.ref_image_id) {
    const refJob = jobsDb.get(imageJobId(project.id, img.ref_image_id));
    if (!refJob || refJob.status !== "done" || !refJob.outputPath) {
      throw new Error(
        `La imagen de referencia "${img.ref_image_id}" todavia no esta aprobada.`
      );
    }
    refImageBytes = await readBytes(project.id, refJob.outputPath);
  }

  const variants = Math.max(1, job.variants || 1);
  logEvent(
    project.id,
    "info",
    `Generando ${variants} variante(s) de imagen "${img.id}" (${img.modo})`,
    { jobId: job.id, model }
  );

  const candidates: Candidate[] = [];
  for (let i = 1; i <= variants; i++) {
    const result = await getImageProvider().generate({
      prompt: img.prompt,
      refImageBytes,
      refImageMimeType: "image/png",
      negativePrompt,
      aspectRatio: ASPECT_RATIO,
      model,
    });
    const ext = result.mimeType.includes("jpeg") ? "jpg" : "png";
    const rel = candidateRelPath(img.id, i, ext);
    await saveBytes(project.id, rel, result.bytes);
    candidates.push({ file: rel, index: i });
  }

  jobsDb.update(job.id, {
    candidates,
    selectedIndex: variants === 1 ? 1 : null,
    outputPath: null,
    model,
  });
  logEvent(project.id, "success", `Imagen "${img.id}" lista, esperando aprobacion.`, {
    jobId: job.id,
    model,
  });
}

async function runVideoGeneration(
  job: JobRecord,
  project: ProjectRecord
): Promise<void> {
  const clip = project.plan.clips.find((c) => c.id === job.refId);
  if (!clip) throw new Error(`Clip "${job.refId}" no existe en el plan.`);
  const model = project.models.video;

  const imgJob = jobsDb.get(imageJobId(project.id, clip.image_id));
  if (!imgJob || imgJob.status !== "done" || !imgJob.outputPath) {
    throw new Error(
      `La imagen "${clip.image_id}" del clip todavia no esta aprobada.`
    );
  }
  const imageBytes = await readBytes(project.id, imgJob.outputPath);

  const resolution = resolveResolution(clip.resolucion ?? project.defaultResolution);
  logEvent(project.id, "info", `Generando video "${clip.id}" con audio (${resolution})`, {
    jobId: job.id,
    model,
  });

  const result = await getVideoProvider().generate({
    imageBytes,
    imageMimeType: "image/png",
    prompt: clip.video_prompt,
    durationSec: clip.duracion_seg,
    aspectRatio: ASPECT_RATIO,
    resolution,
    dialogue: clip.dialogo,
    model,
  });

  const rel = clipRelPath(clip.orden, clip.id);
  await saveBytes(project.id, rel, result.bytes);
  jobsDb.update(job.id, {
    outputPath: rel,
    candidates: [{ file: rel, index: 1 }],
    selectedIndex: 1,
    model,
  });
  logEvent(project.id, "success", `Video "${clip.id}" listo, esperando aprobacion.`, {
    jobId: job.id,
    model,
  });
}

/* ----------------------------- approval ------------------------------ */

/** Aprueba un job. Para imagen, fija el candidato elegido como archivo canonico. */
export async function approveJob(
  jobId: string,
  index?: number
): Promise<JobRecord | undefined> {
  const job = jobsDb.get(jobId);
  if (!job) return undefined;
  const project = projectsDb.get(job.projectId);
  if (!project) return undefined;

  if (job.type === "image") {
    const idx = index ?? job.selectedIndex ?? job.candidates[0]?.index;
    const cand =
      job.candidates.find((c) => c.index === idx) ?? job.candidates[0];
    if (!cand) throw new Error("No hay candidato para aprobar.");
    const ext = path.extname(cand.file).replace(".", "") || "png";
    const canonical = imageRelPath(job.refId, ext);
    await copyWithin(job.projectId, cand.file, canonical);
    const updated = jobsDb.update(jobId, {
      outputPath: canonical,
      selectedIndex: cand.index,
      status: "done",
      locked: true,
      error: null,
    });
    logEvent(job.projectId, "success", `Imagen "${job.refId}" aprobada (v${cand.index}).`, {
      jobId,
    });
    await refreshManifest(job.projectId);
    return updated;
  }

  // video
  const updated = jobsDb.update(jobId, {
    status: "done",
    locked: true,
    error: null,
  });
  logEvent(job.projectId, "success", `Video "${job.refId}" aprobado.`, { jobId });
  await refreshManifest(job.projectId);
  return updated;
}

/** Cambia el prompt de la imagen/clip de un job (para regenerar con otro prompt). */
export function changePrompt(jobId: string, newPrompt: string): JobRecord | undefined {
  const job = jobsDb.get(jobId);
  if (!job) return undefined;
  const project = projectsDb.get(job.projectId);
  if (!project) return undefined;
  const plan = project.plan;

  if (job.type === "image") {
    const found = findImage(plan, job.refId);
    if (found) found.img.prompt = newPrompt;
  } else {
    const clip = plan.clips.find((c) => c.id === job.refId);
    if (clip) clip.video_prompt = newPrompt;
  }
  projectsDb.update(project.id, { plan });
  logEvent(job.projectId, "info", `Prompt actualizado para "${job.refId}".`, {
    jobId,
  });
  return job;
}

/* ----------------------------- manifest ------------------------------ */

export async function refreshManifest(projectId: string): Promise<void> {
  const project = projectsDb.get(projectId);
  if (!project) return;
  await writeManifest(project, jobsDb.byProject(projectId));
}

/* --------------------------- cost estimate --------------------------- */

export function estimateCost(plan: ProjectPlan, imageVariants = 1) {
  const baseImages = plan.assets.reduce((acc, a) => acc + a.images.length, 0);
  const imageCount = baseImages * Math.max(1, imageVariants);
  const iaClips = plan.clips.filter((c) => c.etiqueta === "IA");
  const realClips = plan.clips.filter((c) => c.etiqueta === "FILMAR_REAL");
  const videoSeconds = iaClips.reduce((acc, c) => acc + c.duracion_seg, 0);

  const imageUsd = imageCount * config.pricing.imageUsd;
  const videoUsd = videoSeconds * config.pricing.videoPerSecUsd;
  const total = imageUsd + videoUsd;

  return {
    imageCount,
    baseImages,
    imageVariants: Math.max(1, imageVariants),
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
