/**
 * Configuracion centralizada de la app.
 *
 * Toda la config de modelos/proveedor/almacenamiento vive aca. NO hardcodees
 * endpoints ni IDs de modelo en otros archivos: importalos desde este modulo.
 *
 * Las variables sensibles (identidad de Google Cloud) NO viven aca: se resuelven
 * via Application Default Credentials (ADC) en el backend. Ver src/lib/providers/vertex/auth.ts
 */
import path from "node:path";

export type ProviderMode = "mock" | "vertex";
export type ModelKind = "llm" | "image" | "video";

export interface ModelOption {
  id: string;
  label: string;
}

/**
 * Catalogo de modelos disponibles para los selectores de la UI.
 * IMPORTANTE: estos IDs estan verificados contra los modelos disponibles en el
 * proyecto del usuario (Model Garden / model-versions). Si tu proyecto tiene otros,
 * podes pisarlos por env (LLM_MODEL / IMAGE_MODEL / VIDEO_MODEL).
 * - Imagen: Nano Banana (gemini-*-image). Hace text2image e image2image.
 * - Video: familia Veo 3.1.
 * - Chat: Gemini para interpretar el brief.
 */
export const MODEL_CATALOG: Record<ModelKind, ModelOption[]> = {
  llm: [
    { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
  ],
  image: [
    { id: "gemini-2.5-flash-image", label: "Nano Banana (Gemini 2.5 Flash Image) · recomendado, +cuota" },
    // Variantes mas nuevas (usan la MISMA API generateContent). Pueden requerir que tu
    // proyecto las tenga habilitadas y suelen tener cuota mas baja / costo mayor.
    { id: "gemini-3.1-flash-image-preview", label: "Nano Banana 2 (Gemini 3.1 Flash Image) · probar" },
    { id: "gemini-3-pro-image-preview", label: "Nano Banana Pro (Gemini 3 Pro Image, 4K) · -cuota, +caro" },
  ],
  video: [
    { id: "veo-3.1-generate-001", label: "Veo 3.1" },
    { id: "veo-3.1-fast-generate-001", label: "Veo 3.1 Fast" },
    // Variantes "lite" para testear cual habilita tu proyecto (pueden no estar disponibles).
    { id: "veo-3.1-lite-generate-001", label: "Veo 3.1 Lite (probar)" },
    { id: "veo-3.1-lite-generate-001-preview", label: "Veo 3.1 Lite preview (probar)" },
  ],
};

/** Formato fijo por ahora: vertical 9:16. */
export const ASPECT_RATIO = "9:16";

/** Resoluciones de video que el usuario puede elegir (por video). */
export const VIDEO_RESOLUTIONS = ["720p", "1080p"] as const;
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];

function envDefaultResolution(): VideoResolution {
  const v = process.env.VIDEO_RESOLUTION;
  return (VIDEO_RESOLUTIONS as readonly string[]).includes(v ?? "")
    ? (v as VideoResolution)
    : "720p";
}
export const DEFAULT_RESOLUTION: VideoResolution = envDefaultResolution();

export function resolveResolution(value?: string): VideoResolution {
  return (VIDEO_RESOLUTIONS as readonly string[]).includes(value ?? "")
    ? (value as VideoResolution)
    : DEFAULT_RESOLUTION;
}

/** Duraciones validas de Veo (segundos). Se hace snap al valor mas cercano. */
export const VALID_DURATIONS = [4, 6, 8] as const;

/** Duracion fija (segundos) de una extension de video. */
export const EXTEND_DURATION = 7;

export function snapDuration(sec: number): number {
  let best = VALID_DURATIONS[0] as number;
  let bestDiff = Math.abs(sec - best);
  for (const d of VALID_DURATIONS) {
    const diff = Math.abs(sec - d);
    if (diff < bestDiff) {
      best = d;
      bestDiff = diff;
    }
  }
  return best;
}

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    return "";
  }
  return v;
}

/** Resuelve un path absoluto a partir de cwd (la app corre localmente en la PC). */
function resolveFromCwd(p: string): string {
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

export const config = {
  /** mock = sin credenciales, genera placeholders; vertex = llamadas reales a Vertex AI. */
  providerMode: (env("PROVIDER_MODE", "mock") as ProviderMode) satisfies ProviderMode,

  google: {
    project: env("GOOGLE_CLOUD_PROJECT"),
    location: env("GOOGLE_CLOUD_LOCATION", "us-central1"),
  },

  /**
   * Modelos por defecto (configurables por env y por proyecto via la UI).
   * Verifica los IDs vigentes en la doc oficial de Vertex AI.
   */
  models: {
    // Gemini para interpretar el brief -> PlanJSON estructurado.
    llm: env("LLM_MODEL", "gemini-2.5-flash"),
    // Nano Banana (Gemini image) para text2image E image2image (consistencia de avatar).
    image: env("IMAGE_MODEL", "gemini-2.5-flash-image"),
    // Veo para imagen->video (operacion de larga duracion / LRO).
    video: env("VIDEO_MODEL", "veo-3.1-generate-001"),
  },

  /** Cantidad de variantes por imagen (1-4). Solo aplica a imagenes, no a videos. */
  defaultImageVariants: Math.min(
    4,
    Math.max(1, Number(env("IMAGE_VARIANTS", "1")))
  ),

  storage: {
    // Carpeta raiz de salida. Default ./output. Cada proyecto en ./output/<project_id>/
    outputDir: resolveFromCwd(env("OUTPUT_DIR", "./output")),
    // Estado de proyectos/jobs (JSON local). Nada de servicios externos.
    dataDir: resolveFromCwd(env("DATA_DIR", "./data")),
  },

  pipeline: {
    // Cuantos jobs corren en paralelo.
    concurrency: Number(env("PIPELINE_CONCURRENCY", "2")),
    // Generacion por LOTES: maximo de jobs del MISMO tipo "sin aprobar"
    // (generando + esperando aprobacion) a la vez. Evita disparar los 91 videos
    // juntos (rate limit / fallas). El usuario aprueba el lote y siguen los proximos.
    // 0 = sin limite (comportamiento viejo).
    approvalBatchSize: Math.max(0, Number(env("PIPELINE_APPROVAL_BATCH", "5"))),
    // Reintentos por job antes de marcar failed.
    maxAttempts: Number(env("PIPELINE_MAX_ATTEMPTS", "3")),
    // Backoff base (ms). El delay real es base * 2^(intento-1) con jitter.
    backoffBaseMs: Number(env("PIPELINE_BACKOFF_MS", "1500")),
    // Backoff ESPECIFICO para 429 / rate limit (cuota por minuto). Mucho mas largo:
    // un 429 de RPM se resuelve esperando ~30-60s, no reintentando en 3s.
    rateLimitBackoffMs: Number(env("PIPELINE_RATE_LIMIT_BACKOFF_MS", "35000")),
    // Reintentos extra dedicados a 429 (no consumen los maxAttempts normales).
    rateLimitMaxAttempts: Number(env("PIPELINE_RATE_LIMIT_MAX_ATTEMPTS", "10")),
    // Polling del LRO de Veo.
    veoPollIntervalMs: Number(env("VEO_POLL_INTERVAL_MS", "10000")),
    veoPollTimeoutMs: Number(env("VEO_POLL_TIMEOUT_MS", "600000")), // 10 min
    // Maximo de entradas de log que se guardan por proyecto.
    maxLogEntries: Number(env("PIPELINE_MAX_LOG", "500")),
  },

  /** Estimacion de costo aproximada (solo informativa para la UI antes de generar). */
  pricing: {
    imageUsd: Number(env("PRICE_IMAGE_USD", "0.04")),
    videoPerSecUsd: Number(env("PRICE_VIDEO_PER_SEC_USD", "0.5")),
    llmCallUsd: Number(env("PRICE_LLM_CALL_USD", "0.02")),
  },
} as const;

/** Valida que un id de modelo pertenezca al catalogo del tipo dado. Si no, usa el default. */
export function resolveModel(kind: ModelKind, requested?: string): string {
  if (requested && MODEL_CATALOG[kind].some((m) => m.id === requested)) {
    return requested;
  }
  return config.models[kind];
}

/** URL base de la API REST de Vertex AI para el proyecto/region configurados. */
export function vertexBaseUrl(): string {
  const { location, project } = config.google;
  const host =
    location === "global"
      ? "aiplatform.googleapis.com"
      : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models`;
}

/** Valida que la config necesaria para Vertex este presente. Lanza error claro si falta. */
export function assertVertexConfig(): void {
  const missing: string[] = [];
  if (!config.google.project) missing.push("GOOGLE_CLOUD_PROJECT");
  if (!config.google.location) missing.push("GOOGLE_CLOUD_LOCATION");
  if (missing.length > 0) {
    throw new Error(
      `Faltan variables de entorno para Vertex AI: ${missing.join(", ")}. ` +
        `Configuralas en .env.local y corré 'gcloud auth application-default login'. ` +
        `O usá PROVIDER_MODE=mock para probar sin credenciales.`
    );
  }
}
