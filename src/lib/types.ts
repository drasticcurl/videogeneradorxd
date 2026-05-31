/**
 * Tipos de dominio compartidos entre backend y frontend.
 */
import type { ProjectPlan } from "./schema";

export type JobStatus = "pending" | "generating" | "done" | "failed";
export type JobType = "image" | "video";

export interface JobRecord {
  id: string;
  projectId: string;
  type: JobType;
  /** image.id (type=image) o clip.id (type=video) */
  refId: string;
  /** etiqueta humana para mostrar/ordenar (ej "avatar1_base", "01_hook") */
  label: string;
  /** id del job del que depende (imagen previa); null si no depende de nada */
  dependsOn: string | null;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  /** path relativo (dentro de output/<projectId>/) del archivo generado */
  outputPath: string | null;
  /** info extra para debug/UI (ej operationName de Veo) */
  meta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type ProjectStatus = "draft" | "running" | "done" | "failed" | "partial";

export interface ProjectRecord {
  id: string;
  name: string;
  brief: string;
  plan: ProjectPlan;
  status: ProjectStatus;
  /** path absoluto a la carpeta de salida del proyecto */
  outputDir: string;
  createdAt: string;
  updatedAt: string;
}

/** Entrada del manifest.json por imagen. */
export interface ManifestImage {
  id: string;
  asset_id: string;
  modo: string;
  ref_image_id?: string;
  prompt: string;
  status: JobStatus;
  file: string | null; // path relativo, ej "images/avatar1_base.png"
}

/** Entrada del manifest.json por clip. */
export interface ManifestClip {
  id: string;
  orden: number;
  asset_id: string;
  image_id: string;
  etiqueta: string;
  dialogo: string;
  duracion_seg: number;
  on_screen_text?: string;
  status: JobStatus | "placeholder";
  file: string | null; // path relativo, ej "clips/01_hook.mp4"
}

export interface Manifest {
  project_id: string;
  name: string;
  created_at: string;
  updated_at: string;
  provider_mode: string;
  global: ProjectPlan["global"];
  images: ManifestImage[];
  clips: ManifestClip[];
  final_video: string | null; // "final.mp4" si se hizo stitch
  warnings: string[];
}
