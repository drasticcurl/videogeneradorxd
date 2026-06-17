/**
 * Construccion (idempotente) de los jobs de un proyecto a partir de su plan.
 *  - imagenes text2image / image2image (con dependencias por ref)
 *  - videos IA (dependen de la imagen aprobada)
 *  - clips FILMAR_REAL no generan job (placeholders para subir a mano).
 */
import { config } from "../../config";
import { jobsDb } from "../../db";
import type { JobRecord, ProjectRecord } from "../../types";
import { imageJobId, imageRefIds, videoJobId } from "./shared";

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

  // Set de ids de imagenes GENERADAS (para distinguirlas de las referencias subidas).
  const generatedImageIds = new Set<string>();
  for (const asset of project.plan.assets) {
    for (const img of asset.images) generatedImageIds.add(img.id);
  }

  // Jobs de imagen.
  for (const asset of project.plan.assets) {
    for (const img of asset.images) {
      const id = imageJobId(project.id, img.id);
      // La dependencia solo aplica a referencias que son OTRA imagen generada del
      // proyecto. Si las referencias son fotos subidas (VSL), no hay dependencia.
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
