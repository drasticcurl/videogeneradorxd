/**
 * Mutaciones sobre jobs/plan ya existentes:
 *  - approveJob: aprueba (imagen: fija el candidato elegido como archivo canonico).
 *  - changePrompt: edita prompt/dialogo/duracion/resolucion/modelo/override y persiste al plan.
 *  - extendVideoJob: genera +EXTEND_DURATION de continuacion y la guarda como segmento
 *    separado (clips/NN_<slug>__extK.mp4) para unir en el stitch LOCAL (sin ffmpeg en server).
 */
import path from "node:path";
import {
  ASPECT_RATIO,
  EXTEND_DURATION,
  resolveResolution,
  snapDuration,
} from "../../config";
import { jobsDb, projectsDb } from "../../db";
import { getVideoProvider } from "../../providers";
import {
  copyWithin,
  existsRel,
  imageRelPath,
  readBytes,
  saveBytes,
} from "../../storage";
import type { JobRecord } from "../../types";
import { findImage, logEvent, refreshManifest } from "./shared";

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

/**
 * Cambia campos editables de un job y prepara la regeneracion.
 * - imagen: opts.prompt -> image.prompt
 * - video:  opts.prompt -> clip.video_prompt ; opts.dialogue -> clip.dialogo ;
 *           opts.durationSec -> clip.duracion_seg (snap a 4/6/8) ;
 *           opts.resolution -> clip.resolucion ; opts.finalPrompt -> clip.final_prompt
 */
export function changePrompt(
  jobId: string,
  opts: {
    prompt?: string;
    dialogue?: string;
    durationSec?: number;
    resolution?: string;
    modelOverride?: string;
    /**
     * Override del prompt final (solo videos). String con contenido => se guarda como
     * clip.final_prompt y se usa TAL CUAL. "" => borra el override (vuelve al auto).
     * undefined => no se toca.
     */
    finalPrompt?: string;
  }
): JobRecord | undefined {
  const job = jobsDb.get(jobId);
  if (!job) return undefined;
  const project = projectsDb.get(job.projectId);
  if (!project) return undefined;
  const plan = project.plan;

  if (job.type === "image") {
    const found = findImage(plan, job.refId);
    if (found && opts.prompt !== undefined) found.img.prompt = opts.prompt;
  } else {
    const clip = plan.clips.find((c) => c.id === job.refId);
    if (clip) {
      if (opts.prompt !== undefined) clip.video_prompt = opts.prompt;
      if (opts.dialogue !== undefined) clip.dialogo = opts.dialogue;
      if (opts.durationSec !== undefined) {
        clip.duracion_seg = snapDuration(opts.durationSec);
      }
      if (opts.resolution !== undefined) {
        clip.resolucion = resolveResolution(opts.resolution);
      }
      if (opts.finalPrompt !== undefined) {
        const fp = opts.finalPrompt.trim();
        if (fp) clip.final_prompt = fp;
        else delete clip.final_prompt; // "" => borra el override (vuelve al auto)
      }
    }
  }
  projectsDb.update(project.id, { plan });
  if (opts.modelOverride !== undefined) {
    jobsDb.update(jobId, { modelOverride: opts.modelOverride || null });
  }
  logEvent(job.projectId, "info", `Campos actualizados para "${job.refId}".`, {
    jobId,
  });
  return jobsDb.get(jobId);
}

/**
 * Extiende un video YA generado: genera EXTEND_DURATION (7s) de continuacion y la
 * guarda como SEGMENTO SEPARADO (clips/NN_<slug>__extK.mp4). El stitch local (ZIP)
 * une base + segmentos en orden. Requiere que el job tenga outputPath.
 */
export async function extendVideoJob(jobId: string): Promise<JobRecord | undefined> {
  const job = jobsDb.get(jobId);
  if (!job) return undefined;
  if (job.type !== "video") throw new Error("Solo se pueden extender videos.");
  const project = projectsDb.get(job.projectId);
  if (!project) return undefined;
  const clip = project.plan.clips.find((c) => c.id === job.refId);
  if (!clip) throw new Error(`Clip "${job.refId}" no existe en el plan.`);
  if (!job.outputPath || !existsRel(project.id, job.outputPath)) {
    throw new Error("No hay un video base generado para extender. Genéralo primero.");
  }

  const model = job.modelOverride || project.models.video;
  const resolution = resolveResolution(clip.resolucion ?? project.defaultResolution);
  const baseBytes = await readBytes(project.id, job.outputPath);

  logEvent(
    project.id,
    "info",
    `Extendiendo video "${clip.id}" +${EXTEND_DURATION}s (${resolution})`,
    { jobId: job.id, model }
  );

  const extended = await getVideoProvider().extend({
    videoBytes: baseBytes,
    videoMimeType: "video/mp4",
    prompt: clip.video_prompt,
    durationSec: EXTEND_DURATION,
    aspectRatio: ASPECT_RATIO,
    resolution,
    dialogue: clip.dialogo,
    model,
    accent: project.plan.global.acento ?? "arg",
    assetTipo: project.plan.assets.find((a) => a.id === clip.asset_id)?.tipo,
    promptOverride: clip.final_prompt,
  });

  // Sin ffmpeg en el servidor: guardamos la continuacion como segmento separado.
  const baseRel = job.outputPath;
  const extRelFor = (i: number) => baseRel.replace(/\.mp4$/i, `__ext${i}.mp4`);
  let k = 1;
  while (existsRel(project.id, extRelFor(k))) k++;
  const extRel = extRelFor(k);
  await saveBytes(project.id, extRel, extended.bytes);

  const updated = jobsDb.update(job.id, { model });
  logEvent(
    project.id,
    "success",
    `Extension de "${clip.id}" guardada como segmento separado (${extRel}). ` +
      `Se unira al hacer el stitch local (se incluye en el ZIP de descarga).`,
    { jobId: job.id, model }
  );
  await refreshManifest(project.id);
  return updated;
}
