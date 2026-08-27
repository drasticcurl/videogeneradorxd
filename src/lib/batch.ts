/**
 * LOTE (batch): estado agregado de varios proyectos a la vez.
 *
 * Se usa para dos pantallas:
 *  - /batch          -> tablero (bento grid) con el progreso de cada proyecto.
 *  - /batch/review   -> revision "tipo tinder" de las imagenes que esperan aprobacion.
 *
 * Todo se calcula desde la DB + el plan (fuente de verdad). No toca proveedores.
 */
import { jobsDb, projectsDb } from "./db";
import { config, VIDEO_RESOLUTIONS } from "./config";
import { findImage, imageRefIds, videoJobId } from "./jobs/pipeline";
import { queueSnapshot } from "./jobs/queue";
import type {
  JobRecord,
  JobStatus,
  ProjectStage,
  ProjectStatus,
} from "./types";

export interface BatchCounts {
  total: number;
  pending: number;
  generating: number;
  awaiting: number;
  done: number;
  failed: number;
  /**
   * Jobs que dicen "generating" pero NO estan corriendo en la cola: quedaron
   * colgados (tipico tras reiniciar el server). Se arreglan con "reintentar".
   * Es un subconjunto de `generating`.
   */
  stuck: number;
}

/** Un clip en la linea de tiempo del proyecto (fase videos). */
export interface BatchTimelineItem {
  clipId: string;
  /** id del job de video (null en clips FILMAR_REAL, que no generan nada) */
  videoJobId: string | null;
  orden: number;
  label: string;
  dialogo: string;
  duracionSeg: number;
  etiqueta: string;
  /** prompt visual del clip (lo que se edita antes de regenerar) */
  videoPrompt: string;
  /** override del prompt final que se manda a Veo ("" = armado automatico) */
  finalPrompt: string;
  resolucion: string;
  /** "placeholder" = clip FILMAR_REAL que todavia no subiste. */
  status: JobStatus | "placeholder";
  error: string | null;
  videoUrl: string | null;
  /** frame inicial (imagen aprobada del clip), para mostrar la tira aunque no haya video */
  imageUrl: string | null;
}

export interface BatchProject {
  id: string;
  name: string;
  status: ProjectStatus;
  stage: ProjectStage | null;
  autoApprove: boolean;
  imageVariants: number;
  images: BatchCounts;
  videos: BatchCounts;
  /** ultima imagen aprobada (para la miniatura del card) */
  thumbUrl: string | null;
  /** true si hay jobs de imagen y TODOS estan aprobados */
  imagesReady: boolean;
  /** clips en orden. Solo se llena en fase "videos" (en fase imagenes no hace falta). */
  timeline: BatchTimelineItem[];
}

/** Imagen de referencia de un image2image (foto subida o imagen previa del proyecto). */
export interface BatchReviewRef {
  id: string;
  kind: "reference" | "image";
  label: string;
  url: string | null;
  /** para refs que son imagenes generadas: si todavia no esta aprobada */
  pending?: boolean;
}

/** Clip que usa la imagen que estas revisando (para ver/editar el guion). */
export interface BatchReviewClip {
  videoJobId: string;
  clipId: string;
  orden: number;
  dialogo: string;
  duracionSeg: number;
  etiqueta: string;
  /**
   * false para clips FILMAR_REAL: no tienen job de video, asi que el dialogo no se
   * puede editar por /api/jobs/:id/prompt (se edita en el plan).
   */
  hasJob: boolean;
}

export interface BatchReviewItem {
  jobId: string;
  projectId: string;
  projectName: string;
  imageId: string;
  assetId: string;
  assetTipo: string;
  modo: string;
  prompt: string;
  attempts: number;
  error: string | null;
  updatedAt: string;
  model: string | null;
  /** variantes generadas para elegir (1 o mas) */
  variants: { index: number; url: string }[];
  /** imagenes de referencia (solo image2image) */
  refs: BatchReviewRef[];
  /** todos los clips que usan esta imagen, en orden */
  clips: BatchReviewClip[];
}

export interface BatchSnapshot {
  projects: BatchProject[];
  /** cola de imagenes esperando aprobacion, en orden de llegada (FIFO) */
  review: BatchReviewItem[];
  /** ids pedidos que ya no existen (borrados) */
  missingIds: string[];
  concurrency: number;
  /** rate limit de video: cuantos arranques por ventana (default 4 por minuto) */
  videoRate: { max: number; windowMs: number };
  /** resoluciones de video validas (para el selector del editor de clip) */
  resolutions: string[];
  totals: {
    images: BatchCounts;
    videos: BatchCounts;
  };
}

const emptyCounts = (): BatchCounts => ({
  total: 0,
  pending: 0,
  generating: 0,
  awaiting: 0,
  done: 0,
  failed: 0,
  stuck: 0,
});

function countJobs(jobs: JobRecord[], running: Set<string>): BatchCounts {
  const c = emptyCounts();
  for (const j of jobs) {
    c.total++;
    if (j.status === "pending") c.pending++;
    else if (j.status === "generating") {
      c.generating++;
      // La cola agrega el job a `running` ANTES de marcarlo "generating", asi que
      // si no esta ahi es que el estado en memoria se perdio: quedo colgado.
      if (!running.has(j.id)) c.stuck++;
    } else if (j.status === "awaiting_approval") c.awaiting++;
    else if (j.status === "done") c.done++;
    else if (j.status === "failed") c.failed++;
  }
  return c;
}

function addCounts(target: BatchCounts, extra: BatchCounts): void {
  target.total += extra.total;
  target.pending += extra.pending;
  target.generating += extra.generating;
  target.awaiting += extra.awaiting;
  target.done += extra.done;
  target.failed += extra.failed;
  target.stuck += extra.stuck;
}

/**
 * URL para servir un archivo del proyecto. El `?v=` es cache-busting: cuando se
 * regenera una imagen el path es el mismo y el browser se quedaba con la vieja.
 */
function fileUrl(projectId: string, relPath: string, version?: string): string {
  const v = version ? `?v=${encodeURIComponent(version)}` : "";
  return `/api/files/${projectId}/${relPath}${v}`;
}

/** Variantes candidatas de un job de imagen (o el archivo aprobado si no hay candidatos). */
function variantsOf(job: JobRecord): { index: number; url: string }[] {
  const cands = (job.candidates ?? []).slice().sort((a, b) => a.index - b.index);
  if (cands.length > 0) {
    return cands.map((c) => ({
      index: c.index,
      url: fileUrl(job.projectId, c.file, job.updatedAt),
    }));
  }
  if (job.outputPath) {
    return [
      {
        index: job.selectedIndex ?? 1,
        url: fileUrl(job.projectId, job.outputPath, job.updatedAt),
      },
    ];
  }
  return [];
}

/** Arma el estado del lote para los ids pedidos (en ese orden). */
export function buildBatchSnapshot(ids: string[]): BatchSnapshot {
  const projects: BatchProject[] = [];
  const review: BatchReviewItem[] = [];
  const missingIds: string[] = [];
  const totals = { images: emptyCounts(), videos: emptyCounts() };
  // Jobs realmente en ejecucion, para detectar los colgados en "generating".
  const running = new Set(queueSnapshot().running);

  for (const id of ids) {
    const project = projectsDb.get(id);
    if (!project) {
      missingIds.push(id);
      continue;
    }
    const jobs = jobsDb.byProject(project.id);
    const imageJobs = jobs.filter((j) => j.type === "image");
    const videoJobs = jobs.filter((j) => j.type === "video");
    const images = countJobs(imageJobs, running);
    const videos = countJobs(videoJobs, running);
    addCounts(totals.images, images);
    addCounts(totals.videos, videos);

    // Miniatura del card: la ultima imagen aprobada.
    const lastApproved = imageJobs
      .filter((j) => j.status === "done" && j.outputPath)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];

    // Indices para resolver referencias y guiones.
    const referenceById = new Map(
      (project.plan.references ?? []).map((r) => [r.id, r])
    );
    const imageJobByRef = new Map(imageJobs.map((j) => [j.refId, j]));
    const videoJobByRef = new Map(videoJobs.map((j) => [j.refId, j]));

    // Cola de revision: imagenes generadas esperando tu aprobacion.
    for (const job of imageJobs) {
      if (job.status !== "awaiting_approval") continue;
      const found = findImage(project.plan, job.refId);
      if (!found) continue;
      const { img, asset } = found;

      const refs: BatchReviewRef[] = [];
      if (img.modo === "image2image") {
        for (const rid of imageRefIds(img)) {
          const uploaded = referenceById.get(rid);
          if (uploaded) {
            refs.push({
              id: rid,
              kind: "reference",
              label: uploaded.label || rid,
              url: uploaded.file
                ? fileUrl(project.id, uploaded.file, project.updatedAt)
                : null,
            });
            continue;
          }
          const refJob = imageJobByRef.get(rid);
          refs.push({
            id: rid,
            kind: "image",
            label: rid,
            url:
              refJob?.outputPath
                ? fileUrl(project.id, refJob.outputPath, refJob.updatedAt)
                : null,
            pending: !refJob || refJob.status !== "done",
          });
        }
      }

      const clips: BatchReviewClip[] = project.plan.clips
        .filter((c) => c.image_id === img.id)
        .sort((a, b) => a.orden - b.orden)
        .map((c) => ({
          videoJobId:
            videoJobByRef.get(c.id)?.id ?? videoJobId(project.id, c.id),
          clipId: c.id,
          orden: c.orden,
          dialogo: c.dialogo ?? "",
          duracionSeg: c.duracion_seg,
          etiqueta: c.etiqueta,
          hasJob: videoJobByRef.has(c.id),
        }));

      review.push({
        jobId: job.id,
        projectId: project.id,
        projectName: project.name,
        imageId: img.id,
        assetId: asset.id,
        assetTipo: asset.tipo,
        modo: img.modo,
        prompt: img.prompt,
        attempts: job.attempts,
        error: job.error,
        updatedAt: job.updatedAt,
        model: job.model,
        variants: variantsOf(job),
        refs,
        clips,
      });
    }

    // Linea de tiempo (fase videos): todos los clips en orden con su estado.
    const timeline: BatchTimelineItem[] =
      project.stage === "videos" || videos.done > 0 || videos.awaiting > 0
        ? project.plan.clips
            .slice()
            .sort((a, b) => a.orden - b.orden)
            .map((clip) => {
              const job = videoJobByRef.get(clip.id);
              const imgJob = imageJobByRef.get(clip.image_id);
              return {
                clipId: clip.id,
                videoJobId: job?.id ?? null,
                orden: clip.orden,
                label: `${String(clip.orden).padStart(2, "0")}_${clip.id}`,
                dialogo: clip.dialogo ?? "",
                duracionSeg: clip.duracion_seg,
                etiqueta: clip.etiqueta,
                videoPrompt: clip.video_prompt,
                finalPrompt: clip.final_prompt ?? "",
                resolucion: clip.resolucion ?? project.defaultResolution,
                status:
                  clip.etiqueta === "FILMAR_REAL"
                    ? "placeholder"
                    : job?.status ?? "pending",
                error: job?.error ?? null,
                videoUrl: job?.outputPath
                  ? fileUrl(project.id, job.outputPath, job.updatedAt)
                  : null,
                imageUrl: imgJob?.outputPath
                  ? fileUrl(project.id, imgJob.outputPath, imgJob.updatedAt)
                  : null,
              };
            })
        : [];

    projects.push({
      id: project.id,
      name: project.name,
      status: project.status,
      stage: project.stage ?? null,
      autoApprove:
        typeof project.autoApprove === "boolean"
          ? project.autoApprove
          : config.pipeline.autoApprove,
      imageVariants: project.imageVariants,
      images,
      videos,
      thumbUrl: lastApproved?.outputPath
        ? fileUrl(project.id, lastApproved.outputPath, lastApproved.updatedAt)
        : null,
      imagesReady: images.total > 0 && images.done === images.total,
      timeline,
    });
  }

  // FIFO: primero la que se genero antes, asi revisas en el orden en que van cayendo.
  review.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

  return {
    projects,
    review,
    missingIds,
    concurrency: config.pipeline.concurrency,
    videoRate: {
      max: config.pipeline.videoRateMax,
      windowMs: config.pipeline.videoRateWindowMs,
    },
    resolutions: [...VIDEO_RESOLUTIONS],
    totals,
  };
}
