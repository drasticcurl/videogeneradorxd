/**
 * GET /api/jobs/:id/preview
 * Devuelve TODO lo que se va a ejecutar para ese job, para revisarlo antes de regenerar:
 *  - executedPrompt: el prompt EXACTO que se manda al modelo (Veo o Nano Banana).
 *  - inputImage / refs: la/s imagen/es de entrada (frame inicial del video o referencias).
 *  - json: el objeto del plan (clip o imagen) entero.
 *  - model, duracion, resolucion, etc.
 */
import { jobsDb, projectsDb } from "@/lib/db";
import { ASPECT_RATIO, resolveResolution } from "@/lib/config";
import { buildVeoVideoPrompt, buildImageInstruction } from "@/lib/prompts";
import { notFound, ok, serverError } from "@/lib/http";
import type { Image } from "@/lib/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function findImage(
  project: ReturnType<typeof projectsDb.get>,
  imageId: string
): { assetId: string; img: Image } | null {
  if (!project) return null;
  for (const asset of project.plan.assets) {
    const img = asset.images.find((i) => i.id === imageId);
    if (img) return { assetId: asset.id, img };
  }
  return null;
}

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const job = jobsDb.get(params.id);
    if (!job) return notFound("Job no encontrado");
    const project = projectsDb.get(job.projectId);
    if (!project) return notFound("Proyecto no encontrado");

    const common = {
      jobId: job.id,
      type: job.type,
      label: job.label,
      status: job.status,
      error: job.error,
      updatedAt: job.updatedAt,
      outputPath: job.outputPath,
      aspectRatio: ASPECT_RATIO,
    };

    if (job.type === "video") {
      const clip = project.plan.clips.find((c) => c.id === job.refId);
      if (!clip) return notFound("Clip no encontrado en el plan");
      const found = findImage(project, clip.image_id);
      const imgJob = jobsDb.imageJob(project.id, clip.image_id);
      const executedPrompt = buildVeoVideoPrompt({
        videoPrompt: clip.video_prompt,
        dialogue: clip.dialogo,
        durationSec: clip.duracion_seg,
        aspectRatio: ASPECT_RATIO,
      });
      return ok({
        ...common,
        model: job.modelOverride || project.models.video,
        durationSec: clip.duracion_seg,
        resolution: resolveResolution(clip.resolucion ?? project.defaultResolution),
        executedPrompt,
        inputImage: {
          id: clip.image_id,
          file: imgJob?.outputPath ?? null,
          status: imgJob?.status ?? "pending",
          json: found?.img ?? null,
        },
        json: clip,
      });
    }

    // type === "image"
    const found = findImage(project, job.refId);
    const img = found?.img;
    const refIds = new Set<string>();
    if (img?.ref_image_id) refIds.add(img.ref_image_id);
    for (const r of img?.ref_image_ids ?? []) refIds.add(r);

    const referenceById = new Map(
      (project.plan.references ?? []).map((r) => [r.id, r])
    );
    const refs = Array.from(refIds).map((rid) => {
      const uploaded = referenceById.get(rid);
      if (uploaded) {
        return { id: rid, kind: "subida" as const, file: uploaded.file ?? null };
      }
      const rj = jobsDb.imageJob(project.id, rid);
      return { id: rid, kind: "generada" as const, file: rj?.outputPath ?? null };
    });

    const executedPrompt = buildImageInstruction({
      prompt: img?.prompt ?? "",
      refCount: refs.length,
      aspectRatio: ASPECT_RATIO,
      negativePrompt: img?.negative_prompt || project.plan.global.negative_prompt,
    });

    return ok({
      ...common,
      model: job.modelOverride || project.models.image,
      modo: img?.modo,
      executedPrompt,
      refs,
      json: img ?? null,
    });
  } catch (err) {
    return serverError(err);
  }
}
