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
import { spawnSync } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import {
  config,
  ASPECT_RATIO,
  resolveResolution,
  snapDuration,
  EXTEND_DURATION,
} from "../config";
import { jobsDb, logsDb, projectsDb } from "../db";
import { getImageProvider, getVideoProvider } from "../providers";
import {
  appendLogFile,
  candidateRelPath,
  clipRelPath,
  copyWithin,
  existsRel,
  imageRelPath,
  readBytes,
  saveBytes,
  writeManifest,
} from "../storage";
import { hasFfmpeg } from "../providers/placeholder";
import { runFfmpeg } from "../ffmpeg";
import { ProviderHttpError } from "../providers/types";
import type { ProjectPlan } from "../schema";
import type { Candidate, JobRecord, LogEntry, LogLevel, ProjectRecord } from "../types";

/** Pausa. Se usa para espaciar las variantes de una imagen y para el backoff de 429. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function imageJobId(projectId: string, imageId: string): string {
  return `${projectId}:img:${imageId}`;
}
export function videoJobId(projectId: string, clipId: string): string {
  return `${projectId}:vid:${clipId}`;
}

/** Busca una imagen del plan por id y devuelve tambien su asset. */
export function findImage(plan: ProjectPlan, imageId: string) {
  for (const asset of plan.assets) {
    const img = asset.images.find((i) => i.id === imageId);
    if (img) return { asset, img };
  }
  return null;
}

/** Tipo de asset de un clip ("avatar" | "broll"). Default "avatar" si no se encuentra. */
function clipAssetType(plan: ProjectPlan, assetId: string): "avatar" | "broll" {
  return plan.assets.find((a) => a.id === assetId)?.tipo ?? "avatar";
}

/** Devuelve todos los ids de referencia de una imagen (ref_image_id + ref_image_ids), sin duplicados. */
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
function guessImageMime(rel: string): string {
  const lower = rel.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/png";
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
    modelOverride: null,
    meta: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });

  // Jobs de imagen.
  // Set de ids de imagenes GENERADAS del proyecto (para distinguirlas de las referencias subidas).
  const generatedImageIds = new Set<string>();
  for (const asset of project.plan.assets) {
    for (const img of asset.images) generatedImageIds.add(img.id);
  }

  for (const asset of project.plan.assets) {
    for (const img of asset.images) {
      const id = imageJobId(project.id, img.id);
      // La dependencia solo aplica a referencias que son OTRA imagen generada del
      // proyecto. Si las referencias son fotos subidas (VSL), no hay dependencia:
      // estan en disco y el job puede correr de una.
      const genRef = imageRefIds(img).find((r) => generatedImageIds.has(r));
      const dependsOn =
        img.modo === "image2image" && genRef
          ? imageJobId(project.id, genRef)
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
  const model = job.modelOverride || project.models.image;
  const negativePrompt =
    img.negative_prompt || project.plan.global.negative_prompt || undefined;

  // Reunimos las imagenes de referencia para mantener identidad. Pueden venir de:
  //  - referencias subidas por el usuario (VSL): plan.references[].file en disco.
  //  - otra imagen generada y APROBADA del proyecto.
  const refImages: { bytes: Uint8Array; mimeType?: string }[] = [];
  if (img.modo === "image2image") {
    const referenceById = new Map(
      (project.plan.references ?? []).map((r) => [r.id, r])
    );
    for (const rid of imageRefIds(img)) {
      const uploaded = referenceById.get(rid);
      if (uploaded) {
        if (!uploaded.file || !existsRel(project.id, uploaded.file)) {
          throw new Error(
            `La foto de referencia "${rid}" todavia no se subio al proyecto. Subila antes de generar.`
          );
        }
        refImages.push({
          bytes: await readBytes(project.id, uploaded.file),
          mimeType: guessImageMime(uploaded.file),
        });
      } else {
        const refJob = jobsDb.get(imageJobId(project.id, rid));
        if (!refJob || refJob.status !== "done" || !refJob.outputPath) {
          throw new Error(
            `La imagen de referencia "${rid}" todavia no esta aprobada.`
          );
        }
        refImages.push({
          bytes: await readBytes(project.id, refJob.outputPath),
          mimeType: guessImageMime(refJob.outputPath),
        });
      }
    }
  }

  const variants = Math.max(1, job.variants || 1);

  // Reanudacion: conservamos las variantes YA generadas que sigan en disco, asi un
  // reintento (o un 429 en la 2da) no pierde la 1ra. Solo generamos las que faltan.
  const existing = (job.candidates ?? []).filter((c) =>
    existsRel(project.id, c.file)
  );
  const have = new Set(existing.map((c) => c.index));
  const candidates: Candidate[] = [...existing];
  const missing: number[] = [];
  for (let i = 1; i <= variants; i++) if (!have.has(i)) missing.push(i);

  if (missing.length === 0) {
    jobsDb.update(job.id, {
      candidates,
      selectedIndex: variants === 1 ? 1 : candidates.length === 1 ? candidates[0].index : job.selectedIndex ?? null,
      outputPath: null,
      model,
    });
    return;
  }

  logEvent(
    project.id,
    "info",
    `Generando ${missing.length} variante(s) de imagen "${img.id}" (${img.modo}${
      refImages.length ? `, ${refImages.length} ref` : ""
    }${existing.length ? `, ${existing.length} ya hecha/s` : ""}) · request individual por variante`,
    { jobId: job.id, model }
  );

  // Generamos UNA variante por request (no las dos a la vez). Persistimos cada exito
  // al toque para no perderlo si la siguiente falla (429 / red).
  //
  // Entre variante y variante hay una PAUSA, y un 429 reintenta ESA variante en vez
  // de abandonar el resto. Los dos detalles vienen de un bug real: los modelos de
  // imagen nuevos tienen la cuota tan apretada que la segunda variante mandada
  // pegada a la primera vuelve 429 RESOURCE_EXHAUSTED a los ~200ms. El codigo
  // anterior hacia `break` ahi, asi que pedir 2 variantes devolvia 1 sola, el job
  // pasaba a awaiting_approval sin error y la UI no mostraba que faltaba una.
  let lastErr: unknown;
  let primeraRequest = true;
  for (const i of missing) {
    // La pausa va ANTES de cada request menos la primera: si la imagen tiene una
    // sola variante, no agrega ninguna demora.
    if (!primeraRequest && config.pipeline.imageVariantGapMs > 0) {
      await sleep(config.pipeline.imageVariantGapMs);
    }
    primeraRequest = false;

    const maxIntentos = Math.max(1, config.pipeline.imageVariantRateLimitRetries);
    let salio = false;

    for (let intento = 1; intento <= maxIntentos && !salio; intento++) {
      try {
        const result = await getImageProvider().generate({
          prompt: img.prompt,
          refImages: refImages.length > 0 ? refImages : undefined,
          negativePrompt,
          /*
            El formato y la calidad salen del PROYECTO y no de la constante global:
            la pantalla de imagenes deja elegirlos por proyecto. Un proyecto viejo no
            los tiene guardados, y ahi cae al 9:16 de siempre y a 1K, que es el
            default de la API.
          */
          aspectRatio: project.imageAspectRatio ?? ASPECT_RATIO,
          imageSize: project.imageSize,
          model,
        });
        const ext = result.mimeType.includes("jpeg") ? "jpg" : "png";
        const rel = candidateRelPath(img.id, i, ext);
        await saveBytes(project.id, rel, result.bytes);
        candidates.push({ file: rel, index: i });
        candidates.sort((a, b) => a.index - b.index);
        // Persistimos incrementalmente (cada request individual).
        jobsDb.update(job.id, {
          candidates: [...candidates],
          selectedIndex: variants === 1 ? 1 : job.selectedIndex ?? null,
          outputPath: null,
          model,
        });
        logEvent(project.id, "info", `Variante v${i} de "${img.id}" lista.`, {
          jobId: job.id,
          model,
        });
        salio = true;
      } catch (err) {
        lastErr = err;
        const esCuota =
          err instanceof ProviderHttpError
            ? err.isRateLimit
            : /\(429\)|RESOURCE_EXHAUSTED|rate limit|quota/i.test(
                err instanceof Error ? err.message : String(err)
              );

        // Un error que NO es de cuota (prompt bloqueado, modelo inexistente, red
        // caida) no se arregla esperando: se corta y la cola decide.
        if (!esCuota) {
          logEvent(
            project.id,
            "warn",
            `Variante v${i} de "${img.id}" fallo: ${
              err instanceof Error ? err.message : String(err)
            }`,
            { jobId: job.id, model }
          );
          break;
        }

        if (intento >= maxIntentos) {
          logEvent(
            project.id,
            "warn",
            `Variante v${i} de "${img.id}": sigue en 429 tras ${maxIntentos} intentos. Devuelvo el job a la cola para que espere la ventana de cuota.`,
            { jobId: job.id, model }
          );
          // Se RELANZA en vez de seguir con la variante siguiente.
          //
          // La cuota de estos modelos es POR MINUTO, asi que los reintentos cortos
          // de este loop (segundos) no la resuelven: verificado, con 3s y 5s el 429
          // seguia. La cola ya tiene el mecanismo correcto y tuneado para esto
          // (`rateLimitBackoffMs`, 45s, hasta `rateLimitMaxAttempts` veces, sin
          // consumir los intentos normales del job), y el bloque de arriba de esta
          // funcion ya sabe RETOMAR: filtra las variantes que siguen en disco y
          // pide solo las que faltan. Asi que relanzar no regenera ni cobra dos
          // veces lo que ya salio.
          //
          // Seguir con la variante siguiente, en cambio, era garantia de otro 429:
          // la ventana estaba igual de agotada.
          throw err;
        }

        // Backoff creciente sobre la pausa base, con jitter para no sincronizar
        // varias imagenes que arrancaron juntas.
        const espera =
          config.pipeline.imageVariantGapMs * Math.pow(2, intento - 1) +
          Math.random() * 1000;
        logEvent(
          project.id,
          "warn",
          `Variante v${i} de "${img.id}": 429 de cuota, espero ${Math.round(
            espera / 1000
          )}s y reintento (${intento}/${maxIntentos}).`,
          { jobId: job.id, model }
        );
        await sleep(espera);
      }
    }
  }

  if (candidates.length === 0) {
    // No salio ninguna: relanzamos para que la cola maneje el reintento (429/red).
    throw lastErr ?? new Error(`No se pudo generar ninguna variante de "${img.id}".`);
  }

  // Si salieron menos de las pedidas, queda escrito en el job. Sin esto el job pasa
  // a awaiting_approval como si todo hubiera ido bien y no hay forma de saber, desde
  // la UI, que falta una variante. `error` no cambia el status: las dos UIs lo
  // muestran como una nota (ver JobCard), asi que el job sigue siendo aprobable.
  //
  // Llegar aca con variantes faltantes ya NO puede ser por cuota: ese caso relanza
  // mas arriba para que la cola espere la ventana. Si falta alguna es por un error
  // que no se arregla esperando (prompt bloqueado por los filtros de seguridad,
  // respuesta sin imagen, red). Por eso el mensaje no habla de cuota.
  const faltan = variants - candidates.length;
  const motivo = lastErr instanceof Error ? lastErr.message : String(lastErr ?? "");
  jobsDb.update(job.id, {
    candidates,
    selectedIndex: variants === 1 ? 1 : candidates.length === 1 ? candidates[0].index : job.selectedIndex ?? null,
    outputPath: null,
    model,
    error:
      faltan > 0
        ? `Salieron ${candidates.length}/${variants} variantes. La/s otra/s fallaron: ${motivo.slice(0, 200)}`
        : null,
  });
  if (candidates.length < variants) {
    logEvent(
      project.id,
      "warn",
      `Imagen "${img.id}": salieron ${candidates.length}/${variants} variantes (la/s otra/s falló por cuota o red). Podés aprobar la que salió o tocar Regenerar para completar.`,
      { jobId: job.id, model }
    );
  } else {
    logEvent(
      project.id,
      "success",
      `Imagen "${img.id}" lista (${candidates.length} variante/s), esperando aprobacion.`,
      { jobId: job.id, model }
    );
  }
}

async function runVideoGeneration(
  job: JobRecord,
  project: ProjectRecord
): Promise<void> {
  const clip = project.plan.clips.find((c) => c.id === job.refId);
  if (!clip) throw new Error(`Clip "${job.refId}" no existe en el plan.`);
  const model = job.modelOverride || project.models.video;

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
    assetType: clipAssetType(project.plan, clip.asset_id),
    model,
    promptOverride: clip.final_prompt,
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

/**
 * Cambia campos editables de un job y prepara la regeneracion.
 * - imagen: opts.prompt -> image.prompt
 * - video:  opts.prompt -> clip.video_prompt ; opts.dialogue -> clip.dialogo ;
 *           opts.durationSec -> clip.duracion_seg (snap a 4/6/8) ;
 *           opts.resolution -> clip.resolucion
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
     * Override del prompt final (solo videos). Si es un string con contenido, se guarda
     * como clip.final_prompt y se usa TAL CUAL en la generacion. Si es "" (string vacio),
     * se BORRA el override y vuelve al armado automatico. undefined = no se toca.
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
  // Si se eligio un modelo distinto para este job, lo guardamos como override.
  if (opts.modelOverride !== undefined) {
    jobsDb.update(jobId, { modelOverride: opts.modelOverride || null });
  }
  logEvent(job.projectId, "info", `Campos actualizados para "${job.refId}".`, {
    jobId,
  });
  return jobsDb.get(jobId);
}

/**
 * Extiende un video YA generado, agregando EXTEND_DURATION (7s) de continuacion,
 * y reemplaza el archivo del clip por el video extendido (concatenado).
 * Requiere que el job de video tenga outputPath (un video existente).
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
    assetType: clipAssetType(project.plan, clip.asset_id),
    model,
    promptOverride: clip.final_prompt,
  });

  // Concatenamos base + extension en un solo archivo (si hay ffmpeg). Si no, reemplazamos.
  const rel = clipRelPath(clip.orden, clip.id);
  const merged = await concatVideos(project.id, baseBytes, extended.bytes);
  await saveBytes(project.id, rel, merged ?? extended.bytes);

  const updated = jobsDb.update(job.id, {
    outputPath: rel,
    candidates: [{ file: rel, index: 1 }],
    selectedIndex: 1,
    status: "awaiting_approval",
    locked: false,
    model,
  });
  logEvent(project.id, "success", `Video "${clip.id}" extendido, esperando aprobacion.`, {
    jobId: job.id,
    model,
  });
  await refreshManifest(project.id);
  return updated;
}

/* ----------------------------- manifest ------------------------------ */

/**
 * Concatena base + extension en un solo mp4 usando ffmpeg (re-encode para evitar
 * problemas de timestamps). Devuelve los bytes del video unido, o null si no hay
 * ffmpeg (en ese caso el caller usa solo la extension).
 */
async function concatVideos(
  projectId: string,
  baseBytes: Uint8Array,
  extBytes: Uint8Array
): Promise<Uint8Array | null> {
  if (!hasFfmpeg()) return null;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "augc_ext_"));
  const baseFile = path.join(tmpDir, "base.mp4");
  const extFile = path.join(tmpDir, "ext.mp4");
  const outFile = path.join(tmpDir, "out.mp4");
  try {
    fs.writeFileSync(baseFile, baseBytes);
    fs.writeFileSync(extFile, extBytes);
    // Re-encode + concat por filtro (robusto ante distintos timestamps/SAR).
    // Via runFfmpeg y no spawnSync directo: asi este ffmpeg tambien respeta el limite
    // de cores y deja uno libre para el resto de la maquina (ver lib/ffmpeg.ts).
    const res = runFfmpeg([
      "-y",
      "-i",
      baseFile,
      "-i",
      extFile,
      "-filter_complex",
      "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[outv][outa]",
      "-map",
      "[outv]",
      "-map",
      "[outa]",
      "-c:v",
      "libx264",
      "-crf",
      "18",
      "-preset",
      "medium",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      outFile,
    ]);
    if (res.status !== 0 || !fs.existsSync(outFile)) {
      logEvent(
        projectId,
        "warn",
        "No se pudo concatenar la extension con ffmpeg; se usa solo la continuacion."
      );
      return null;
    }
    return fs.readFileSync(outFile);
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

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
