/**
 * Interfaces de proveedores de IA. La app habla SIEMPRE contra estas interfaces;
 * los adaptadores concretos (mock / vertex) son intercambiables por env (PROVIDER_MODE).
 *
 * El modelo concreto se pasa POR LLAMADA (lo elige el usuario por proyecto).
 */
import type { ProjectPlan } from "../schema";

/**
 * Error HTTP de un proveedor (Vertex). Lleva el status y, si vino, el Retry-After
 * (ms) para que la cola maneje los 429 (rate limit / cuota) con backoff largo.
 */
export class ProviderHttpError extends Error {
  status: number;
  retryAfterMs?: number;
  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
  get isRateLimit(): boolean {
    return this.status === 429;
  }
}

/** Parsea el header Retry-After (segundos o fecha HTTP) a milisegundos. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export interface LlmProvider {
  /** Interpreta el brief en lenguaje natural y devuelve el PlanJSON estructurado. */
  parseBrief(
    text: string,
    opts?: {
      model?: string;
      /**
       * Avatares/fotos de referencia que el usuario ya subió (VSL). El parser los
       * usa como fuente de identidad: cada persona se modela como un asset cuyos
       * planos son image2image contra su reference.id.
       */
      references?: { id: string; label?: string }[];
    }
  ): Promise<ProjectPlan>;
}

/** Una imagen de referencia (bytes + mime) para mantener identidad en image2image. */
export interface RefImage {
  bytes: Uint8Array;
  mimeType?: string;
}

export interface ImageGenInput {
  prompt: string;
  /** Si viene, se hace image2image / edicion manteniendo identidad (Nano Banana). */
  refImageBytes?: Uint8Array;
  refImageMimeType?: string;
  /**
   * Referencias MULTIPLES (VSL): permite pasar varias fotos de identidad en una
   * misma generacion (ej. dos personas en el mismo plano). Si viene, tiene
   * prioridad sobre refImageBytes.
   */
  refImages?: RefImage[];
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
  /** resolucion del video (720p / 1080p). */
  resolution?: string;
  /** dialogo a usar para audio (Veo genera el audio hablado). */
  dialogue?: string;
  /** id de modelo de video (Veo 3.1). */
  model?: string;
  /**
   * OVERRIDE del prompt final. Si viene con contenido, se manda TAL CUAL a Veo y se
   * ignora el armado automatico (estilo UGC/selfie, lip-sync, voz/acento).
   */
  promptOverride?: string;
}

export interface VideoGenResult {
  /** Bytes del video (mp4). Si el modelo solo devuelve gcsUri, el adapter lo descarga a bytes. */
  bytes: Uint8Array;
  mimeType: string;
  /** uri original (gs://...) si aplica, para trazabilidad. */
  gcsUri?: string;
}

export interface VideoExtendInput {
  /** video base (mp4) que se quiere extender. */
  videoBytes: Uint8Array;
  videoMimeType?: string;
  prompt: string;
  /** segundos a extender (siempre 7 por ahora). */
  durationSec: number;
  aspectRatio?: string;
  resolution?: string;
  dialogue?: string;
  model?: string;
  /** OVERRIDE del prompt final (se manda tal cual, sin armado automatico). */
  promptOverride?: string;
}

export interface VideoProvider {
  generate(input: VideoGenInput): Promise<VideoGenResult>;
  /** Extiende un video ya generado (continuacion). Devuelve el video extendido. */
  extend(input: VideoExtendInput): Promise<VideoGenResult>;
}

export interface Providers {
  llm: LlmProvider;
  image: ImageProvider;
  video: VideoProvider;
}
