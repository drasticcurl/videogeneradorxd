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
  // Un solo modelo de chat a pedido del usuario: 2.5 Pro. Se sacaron 3.5 Flash,
  // 2.5 Flash y 2.5 Flash Lite.
  //
  // OJO si algun dia se agrega otro: `resolveModel()` cae al default cuando el id
  // pedido NO esta en esta lista, asi que sacar un modelo de aca sin cambiar el
  // default de `models.llm` mas abajo deja la app usando un modelo que la UI no
  // muestra. Por eso el default se movio a 2.5 Pro en el mismo cambio.
  llm: [{ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" }],
  // Solo Nano Banana. Se sacaron las variantes 3.1 Flash Image y 3 Pro Image.
  image: [
    { id: "gemini-2.5-flash-image", label: "Nano Banana (Gemini 2.5 Flash Image)" },
  ],
  // Los cuatro de video se mantienen. El default es Lite (ver `models.video`).
  video: [
    { id: "veo-3.1-lite-generate-001", label: "Veo 3.1 Lite · default, mas barato" },
    { id: "veo-3.1-generate-001", label: "Veo 3.1" },
    { id: "veo-3.1-fast-generate-001", label: "Veo 3.1 Fast" },
    // Verificado contra el proyecto el 2026-08-27: este devuelve 404 ("Publisher
    // model not found"). Los otros tres responden OK. Se deja en la lista porque
    // se pidio no sacar ninguno, pero la etiqueta lo dice para que nadie lo elija
    // y se coma un fallo en cada job. Si Google lo habilita, se saca el aviso.
    {
      id: "veo-3.1-lite-generate-001-preview",
      label: "Veo 3.1 Lite preview · NO disponible en este proyecto (404)",
    },
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
    // 2.5 Pro y no 2.5 Flash: es el unico que quedo en MODEL_CATALOG.llm, y el
    // default TIENE que estar en el catalogo (ver el comentario de MODEL_CATALOG).
    llm: env("LLM_MODEL", "gemini-2.5-pro"),
    // Nano Banana (Gemini image) para text2image E image2image (consistencia de avatar).
    image: env("IMAGE_MODEL", "gemini-2.5-flash-image"),
    // Veo para imagen->video (operacion de larga duracion / LRO).
    // Lite por default: es el mas barato de los tres que responden OK en este
    // proyecto. Los otros dos siguen disponibles en el selector.
    video: env("VIDEO_MODEL", "veo-3.1-lite-generate-001"),
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
    // Cuantos jobs corren en PARALELO (ventana rolling). Con auto-aprobacion, esto
    // define los "batches": p.ej. 3 videos a la vez; cuando uno termina, arranca el siguiente.
    concurrency: Number(env("PIPELINE_CONCURRENCY", "3")),
    // Auto-aprobacion: si true (default), cada imagen/video se aprueba SOLA al terminar
    // (pasa a "done" y desbloquea lo que depende). Asi se puede dejar generando toda la
    // noche sin aprobar nada. Poné PIPELINE_AUTO_APPROVE=false para volver al modo manual.
    autoApprove:
      env("PIPELINE_AUTO_APPROVE", "true").toLowerCase() !== "false",
    // Generacion por LOTES (solo aplica en modo manual, autoApprove=false): maximo de
    // jobs del mismo tipo "sin aprobar" a la vez. Con autoApprove se ignora.
    approvalBatchSize: Math.max(0, Number(env("PIPELINE_APPROVAL_BATCH", "5"))),
    // Reintentos por job antes de marcar failed.
    maxAttempts: Number(env("PIPELINE_MAX_ATTEMPTS", "3")),
    // Backoff base (ms). El delay real es base * 2^(intento-1) con jitter.
    backoffBaseMs: Number(env("PIPELINE_BACKOFF_MS", "1500")),
    // Backoff ESPECIFICO para 429 / rate limit (cuota por minuto). Mucho mas largo:
    // un 429 de RPM se resuelve esperando ~45s, no reintentando en 3s.
    rateLimitBackoffMs: Number(env("PIPELINE_RATE_LIMIT_BACKOFF_MS", "45000")),
    // Backoff base para errores de RED ("fetch failed", timeouts, conexion cortada).
    // Crece exponencial hasta 30s. Son transitorios: conviene reintentar varias veces.
    networkBackoffMs: Number(env("PIPELINE_NETWORK_BACKOFF_MS", "4000")),
    // Timeout por request de imagen (ms). Si la conexion se cuelga, aborta y reintenta.
    imageTimeoutMs: Number(env("PIPELINE_IMAGE_TIMEOUT_MS", "120000")),
    // Reintentos extra dedicados a errores transitorios (429 + red); cuenta aparte
    // de los maxAttempts normales.
    rateLimitMaxAttempts: Number(env("PIPELINE_RATE_LIMIT_MAX_ATTEMPTS", "10")),
    // Polling del LRO de Veo.
    veoPollIntervalMs: Number(env("VEO_POLL_INTERVAL_MS", "10000")),
    veoPollTimeoutMs: Number(env("VEO_POLL_TIMEOUT_MS", "600000")), // 10 min
    // Maximo de entradas de log que se guardan por proyecto.
    maxLogEntries: Number(env("PIPELINE_MAX_LOG", "500")),

    /**
     * RATE LIMIT de VIDEO (Veo). Ventana deslizante: como maximo `videoRateMax`
     * arranques de video cada `videoRateWindowMs`. Default: 4 por minuto.
     * Es aparte de la concurrencia: la concurrencia limita cuantos corren a la vez,
     * esto limita cuantos se LARGAN por minuto (que es lo que cuenta la cuota).
     */
    videoRateMax: Math.max(1, Number(env("PIPELINE_VIDEO_RATE_MAX", "4"))),
    videoRateWindowMs: Math.max(
      1000,
      Number(env("PIPELINE_VIDEO_RATE_WINDOW_MS", "60000"))
    ),
    /**
     * Cuantas veces un video que fallo vuelve a la cola desde cero (con presupuesto
     * de intentos nuevo) antes de darlo por perdido.
     */
    videoRequeueMax: Math.max(0, Number(env("PIPELINE_VIDEO_REQUEUE_MAX", "5"))),
  },

  /** Estimacion de costo aproximada (solo informativa para la UI antes de generar). */
  pricing: {
    imageUsd: Number(env("PRICE_IMAGE_USD", "0.04")),
    videoPerSecUsd: Number(env("PRICE_VIDEO_PER_SEC_USD", "0.5")),
    llmCallUsd: Number(env("PRICE_LLM_CALL_USD", "0.02")),
  },

  /**
   * Auth de la app. La app corre en un subdominio publico, asi que el acceso se
   * cierra con un password-gate por usuario (ver src/lib/auth.ts).
   *
   * `users` se arma leyendo `PASSWORD_<NOMBRE>` del environment: cada var declara
   * un usuario. Asi agregar o sacar gente es tocar el .env y reiniciar, sin
   * recompilar ni editar codigo.
   *
   * Se resuelve en cada acceso (getter) y no una vez al importar el modulo:
   * `config` es un objeto congelado que Next puede evaluar durante el build, y
   * ahi las vars de runtime todavia no estan. Con el getter, el valor se lee
   * cuando corre el request.
   */
  auth: {
    /** Secret con el que se firman las cookies de sesion. Sin esto no entra nadie. */
    get secret(): string {
      return env("AUTH_SECRET");
    },
    /** Horas de vida de la sesion antes de tener que volver a loguearse. */
    get sessionHours(): number {
      const n = Number(env("AUTH_SESSION_HOURS", "72"));
      return Number.isFinite(n) && n > 0 ? n : 72;
    },
  },
} as const;

/**
 * Usuarios habilitados, leidos de `PASSWORD_<NOMBRE>` del environment.
 *
 * Ejemplo: `PASSWORD_IVAN=xxx` y `PASSWORD_LUCHO=yyy` habilitan a `ivan` y
 * `lucho`. El nombre se normaliza a minusculas para que el login no dependa de
 * como lo escriba el usuario en el form.
 *
 * NO se cachea en un modulo-level const: en el build de Next las vars de runtime
 * no existen todavia, y un valor cacheado vacio dejaria la app sin usuarios.
 */
export function authUsers(): Map<string, string> {
  const users = new Map<string, string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("PASSWORD_")) continue;
    if (!value) continue;
    const name = key.slice("PASSWORD_".length).toLowerCase();
    if (name) users.set(name, value);
  }
  return users;
}

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
