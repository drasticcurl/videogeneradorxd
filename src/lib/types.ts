/**
 * Tipos de dominio compartidos entre backend y frontend.
 */
import type { ProjectPlan } from "./schema";

/** awaiting_approval = generado, esperando que el usuario apruebe (imagenes y videos). */
export type JobStatus =
  | "pending"
  | "generating"
  | "awaiting_approval"
  | "done"
  | "failed";
export type JobType = "image" | "video";

/** Una variante candidata generada para una imagen (cuando variants > 1). */
export interface Candidate {
  /** path relativo dentro de output/<projectId>/ */
  file: string;
  index: number;
}

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
  /** path relativo (dentro de output/<projectId>/) del archivo aprobado/elegido */
  outputPath: string | null;
  /** candidatos generados (solo imagenes con variants>1, o siempre como historial) */
  candidates: Candidate[];
  /** indice del candidato elegido */
  selectedIndex: number | null;
  /** cuantas variantes generar (solo imagenes) */
  variants: number;
  /** una vez aprobado y bloqueado, no se regenera por "reanudar" */
  locked: boolean;
  /** modelo usado en la ultima ejecucion (para el log/manifest) */
  model: string | null;
  /** override de modelo elegido por el usuario para ESTE job (pisa el del proyecto) */
  modelOverride: string | null;
  /** info extra para debug/UI (ej operationName de Veo) */
  meta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type ProjectStatus =
  | "draft"
  | "running"
  | "review"
  | "done"
  | "failed"
  | "partial"
  | "paused";

export interface ProjectModels {
  llm: string;
  image: string;
  video: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  brief: string;
  plan: ProjectPlan;
  status: ProjectStatus;
  /** modelos elegidos para este proyecto */
  models: ProjectModels;
  /** variantes por imagen (1-4) */
  imageVariants: number;
  /** resolucion de video por defecto del proyecto (720p / 1080p) */
  defaultResolution: string;
  /** path absoluto a la carpeta de salida del proyecto */
  outputDir: string;
  createdAt: string;
  updatedAt: string;
}

export type LogLevel = "info" | "warn" | "error" | "success";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  message: string;
  jobId?: string;
  model?: string;
}

/** Entrada del manifest.json por imagen. */
export interface ManifestImage {
  id: string;
  asset_id: string;
  modo: string;
  ref_image_id?: string;
  ref_image_ids?: string[];
  prompt: string;
  status: JobStatus;
  file: string | null; // path relativo, ej "images/avatar1_base.png"
  model: string | null;
}

/** Entrada del manifest.json por imagen de referencia subida (VSL). */
export interface ManifestReference {
  id: string;
  label?: string;
  file: string | null; // path relativo, ej "references/natalia.png"
  status: "uploaded" | "missing";
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
  resolucion?: string;
  status: JobStatus | "placeholder";
  file: string | null; // path relativo, ej "clips/01_hook.mp4"
  model: string | null;
}

export interface Manifest {
  project_id: string;
  name: string;
  created_at: string;
  updated_at: string;
  provider_mode: string;
  models: ProjectModels;
  global: ProjectPlan["global"];
  references: ManifestReference[];
  images: ManifestImage[];
  clips: ManifestClip[];
  final_video: string | null; // "final.mp4" si se hizo stitch
  warnings: string[];
}
