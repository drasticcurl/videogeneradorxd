/**
 * Interfaces de proveedores de IA. La app habla SIEMPRE contra estas interfaces;
 * los adaptadores concretos (mock / vertex) son intercambiables por env (PROVIDER_MODE).
 *
 * El modelo concreto se pasa POR LLAMADA (lo elige el usuario por proyecto).
 */
import type { ProjectPlan } from "../schema";

export interface LlmProvider {
  /** Interpreta el brief en lenguaje natural y devuelve el PlanJSON estructurado. */
  parseBrief(text: string, opts?: { model?: string }): Promise<ProjectPlan>;
}

export interface ImageGenInput {
  prompt: string;
  /** Si viene, se hace image2image / edicion manteniendo identidad (Nano Banana). */
  refImageBytes?: Uint8Array;
  refImageMimeType?: string;
  negativePrompt?: string;
  aspectRatio?: string;
  /** id de modelo de imagen (Nano Banana). */
  model?: string;
}

export interface ImageGenResult {
  bytes: Uint8Array;
  mimeType: string;
}

export interface ImageProvider {
  /** Genera UNA imagen. Las variantes se logran llamando N veces desde el pipeline. */
  generate(input: ImageGenInput): Promise<ImageGenResult>;
}

export interface VideoGenInput {
  imageBytes: Uint8Array;
  imageMimeType?: string;
  prompt: string;
  durationSec: number;
  aspectRatio?: string;
  /** dialogo a usar para audio (Veo genera el audio hablado). */
  dialogue?: string;
  /** id de modelo de video (Veo 3.1). */
  model?: string;
}

export interface VideoGenResult {
  /** Bytes del video (mp4). Si el modelo solo devuelve gcsUri, el adapter lo descarga a bytes. */
  bytes: Uint8Array;
  mimeType: string;
  /** uri original (gs://...) si aplica, para trazabilidad. */
  gcsUri?: string;
}

export interface VideoProvider {
  generate(input: VideoGenInput): Promise<VideoGenResult>;
}

export interface Providers {
  llm: LlmProvider;
  image: ImageProvider;
  video: VideoProvider;
}
