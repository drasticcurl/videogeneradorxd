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
   * IDs de modelo. Verificados contra la doc oficial de Vertex AI (2025).
   * Si Google publica nuevas versiones, cambialas por env var sin tocar el codigo.
   */
  models: {
    // Gemini para interpretar el brief -> PlanJSON estructurado.
    llm: env("LLM_MODEL", "gemini-2.5-flash"),
    // Imagen para text2image. (ej. imagen-4.0-generate-001 / imagen-4.0-fast-generate-001)
    image: env("IMAGE_MODEL", "imagen-4.0-generate-001"),
    // Modelo de imagen de Gemini para image2image / edicion con referencia (consistencia de avatar).
    // "Nano Banana" mantiene identidad muy bien. Configurable por si se prefiere imagen-3 capability.
    imageEdit: env("IMAGE_EDIT_MODEL", "gemini-2.5-flash-image"),
    // Veo para imagen->video (operacion de larga duracion / LRO).
    video: env("VIDEO_MODEL", "veo-3.0-generate-001"),
  },

  storage: {
    // Carpeta raiz de salida. Default ./output. Cada proyecto en ./output/<project_id>/
    outputDir: resolveFromCwd(env("OUTPUT_DIR", "./output")),
    // Estado de proyectos/jobs (JSON local). Nada de servicios externos.
    dataDir: resolveFromCwd(env("DATA_DIR", "./data")),
  },

  pipeline: {
    // Cuantos jobs corren en paralelo.
    concurrency: Number(env("PIPELINE_CONCURRENCY", "2")),
    // Reintentos por job antes de marcar failed.
    maxAttempts: Number(env("PIPELINE_MAX_ATTEMPTS", "3")),
    // Backoff base (ms). El delay real es base * 2^(intento-1) con jitter.
    backoffBaseMs: Number(env("PIPELINE_BACKOFF_MS", "1500")),
    // Polling del LRO de Veo.
    veoPollIntervalMs: Number(env("VEO_POLL_INTERVAL_MS", "10000")),
    veoPollTimeoutMs: Number(env("VEO_POLL_TIMEOUT_MS", "600000")), // 10 min
  },

  /** Estimacion de costo aproximada (solo informativa para la UI antes de generar). */
  pricing: {
    imageUsd: Number(env("PRICE_IMAGE_USD", "0.04")),
    videoPerSecUsd: Number(env("PRICE_VIDEO_PER_SEC_USD", "0.5")),
    llmCallUsd: Number(env("PRICE_LLM_CALL_USD", "0.02")),
  },
} as const;

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
