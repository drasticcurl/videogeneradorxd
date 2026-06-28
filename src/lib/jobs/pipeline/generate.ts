/**
 * Ejecucion de la generacion de un job (imagen o video) contra el provider activo.
 * Guarda archivos y actualiza candidates/outputPath/model. NO fija el estado final:
 * la cola lo pasa a "awaiting_approval". Lanza si falla (la cola maneja reintentos).
 */
import { ASPECT_RATIO, resolveResolution } from "../../config";
import { jobsDb, projectsDb } from "../../db";
import { getImageProvider, getVideoProvider } from "../../providers";
import {
  candidateRelPath,
  clipRelPath,
  existsRel,
  readBytes,
  saveBytes,
} from "../../storage";
import type { Candidate, JobRecord, ProjectRecord } from "../../types";
import {
  findImage,
  guessImageMime,
  imageJobId,
  imageRefIds,
  logEvent,
} from "./shared";

/** Dispatcher: ejecuta la generacion segun el tipo de job. */
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
      selectedIndex:
        variants === 1
          ? 1
          : candidates.length === 1
          ? candidates[0].index
          : job.selectedIndex ?? null,
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

  // Generamos UNA variante por request. Persistimos cada exito al toque para no
  // perderlo si la siguiente falla (429 / red).
  let lastErr: unknown;
  for (const i of missing) {
    try {
      const result = await getImageProvider().generate({
        prompt: img.prompt,
        refImages: refImages.length > 0 ? refImages : undefined,
        negativePrompt,
        aspectRatio: ASPECT_RATIO,
        model,
      });
      const ext = result.mimeType.includes("jpeg") ? "jpg" : "png";
      const rel = candidateRelPath(img.id, i, ext);
      await saveBytes(project.id, rel, result.bytes);
      candidates.push({ file: rel, index: i });
      candidates.sort((a, b) => a.index - b.index);
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
    } catch (err) {
      lastErr = err;
      logEvent(
        project.id,
        "warn",
        `Variante v${i} de "${img.id}" fallo: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { jobId: job.id, model }
      );
      // No seguimos pegando si una fallo (probable 429/red): devolvemos lo que haya.
      break;
    }
  }

  if (candidates.length === 0) {
    throw lastErr ?? new Error(`No se pudo generar ninguna variante de "${img.id}".`);
  }

  jobsDb.update(job.id, {
    candidates,
    selectedIndex:
      variants === 1
        ? 1
        : candidates.length === 1
        ? candidates[0].index
        : job.selectedIndex ?? null,
    outputPath: null,
    model,
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

  const assetTipo = project.plan.assets.find((a) => a.id === clip.asset_id)?.tipo;
  const result = await getVideoProvider().generate({
    imageBytes,
    imageMimeType: "image/png",
    prompt: clip.video_prompt,
    durationSec: clip.duracion_seg,
    aspectRatio: ASPECT_RATIO,
    resolution,
    dialogue: clip.dialogo,
    model,
    accent: project.plan.global.acento ?? "arg",
    assetTipo,
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
