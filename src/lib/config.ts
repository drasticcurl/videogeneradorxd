/**
 * Configuracion centralizada de la app.
 *
 * Toda la config de modelos/proveedor/almacenamiento vive aca. NO hardcodees
 * endpoints ni IDs de modelo en otros archivos: importalos desde este modulo.
 *
 * Las credenciales de Google Cloud NO viven aca. Aca se resuelve la cuenta que sale del
 * environment (`vertexCuentaDelEnv`); la resolucion completa, que antes mira la que el
 * usuario cargo desde la app, es `vertexCuentaFor` en src/lib/cuentaVertex.ts. El token
 * lo saca src/lib/providers/vertex/auth.ts.
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
/**
 * Catalogo de modelos para los selectores de la UI.
 *
 * TODOS estos IDs estan verificados con una request real contra el proyecto en el
 * endpoint `global` (2026-08-27). Los modelos 3.x NO existen en los endpoints
 * regionales: en us-central1 dan 404. Por eso `google.location` es `global`; si
 * alguien la vuelve a poner en una region, la mitad de este catalogo deja de
 * responder. Ver el comentario de `location` mas abajo.
 *
 * OJO al editar: `resolveModel()` cae al default cuando el id pedido NO esta en
 * esta lista, asi que sacar un modelo de aca sin mover el default correspondiente
 * en `models` deja la app generando con un modelo que la UI no muestra.
 */
export const MODEL_CATALOG: Record<ModelKind, ModelOption[]> = {
  // 3.6 queda de default y 3.7 como opcion.
  //
  // Sobre 3.7: la primera vez que se probo contesto 429 (capacidad agotada, NO
  // 404), asi que se volvio a medir: 5/5 exitosos. El 429 era momentaneo. Pero es
  // mas lento y mas irregular que 3.6 (1.6-5.2s contra 1.4-1.7s parejo en el mismo
  // prompt trivial), y al parsear un brief largo eso se acumula. Por eso 3.6 sigue
  // siendo el default.
  //
  // 3.5 Flash, 3.1 Flash-Lite y 3.5 Flash-Lite tambien responden en global, por si
  // alguna vez se quieren agregar.
  //
  // Los emojis son la leyenda: ⚡ rapido, 🧠 mas capaz, 🪙 mas barato. Son emoji
  // Unicode estandar (⚡ U+26A1, 🧠 U+1F9E0, 🪙 U+1FA99), no un pack propio ni un
  // icon font: los renderiza la fuente del sistema, asi que no agregan ninguna
  // dependencia ni request.
  llm: [
    { id: "gemini-3.6-flash", label: "⚡ Gemini 3.6 Flash" },
    { id: "gemini-3.7-flash", label: "🧠 Gemini 3.7 Flash" },
  ],
  // Las tres variantes de Nano Banana, de mayor a menor calidad.
  image: [
    { id: "gemini-3.1-flash-image", label: "⚡ Nano Banana 2" },
    { id: "gemini-3-pro-image", label: "🧠 Nano Banana Pro" },
    // 🪙 = barato. Devuelve imagenes de ~56 KB contra ~1.1 MB de las otras dos:
    // esta pensado para volumen y latencia, no para calidad.
    { id: "gemini-3.1-flash-lite-image", label: "🪙 Nano Banana 2 Lite" },
  ],
  // Veo 3.1 es la linea mas nueva que existe: veo-3.2 y veo-4.0 dan 404. Estas
  // tres son sus variantes, de menor a mayor costo.
  video: [
    { id: "veo-3.1-lite-generate-001", label: "🪙 Veo 3.1 Lite" },
    { id: "veo-3.1-fast-generate-001", label: "⚡ Veo 3.1 Fast" },
    { id: "veo-3.1-generate-001", label: "🧠 Veo 3.1" },
  ],
};

/*
  Formatos y calidades de imagen: viven en `./formatos`, que es un modulo puro (sin
  imports ni environment). Se re-exportan desde aca para que el server siga teniendo
  un solo lugar donde mirar, pero el CLIENTE importa `@/lib/formatos` directo: este
  archivo trae `node:path` y lee AUTH_SECRET y PASSWORD_*, y no puede entrar al bundle
  del browser.
*/
export {
  ASPECT_RATIO,
  IMAGE_ASPECT_RATIOS,
  IMAGE_MODELS_SOLO_1K,
  IMAGE_SIZES,
  imageSizesFor,
  resolveAspectRatio,
  resolveImageSize,
  type FormatoImagen,
  type ImageSize,
  type Orientacion,
} from "./formatos";

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

/**
 * Numero de env acotado a [min, max]. Si no es un numero, el default. Los limites de
 * la voz no son decorativos: un VOICE_CHUNK_MAX_SEC de 400 manda tramos que
 * ElevenLabs rechaza (tope 300 s), y uno de 0 haria un pedido por muestra.
 */
function envAcotado(name: string, fallback: number, min: number, max: number): number {
  const n = Number(env(name, String(fallback)));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Resuelve un path absoluto a partir de cwd (la app corre localmente en la PC). */
function resolveFromCwd(p: string): string {
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

export const config = {
  /** mock = sin credenciales, genera placeholders; vertex = llamadas reales a Vertex AI. */
  providerMode: (env("PROVIDER_MODE", "mock") as ProviderMode) satisfies ProviderMode,

  google: {
    /**
     * Proyecto de la cuenta COMPARTIDA: la usa quien no tiene una propia. No lo leas
     * directo para armar una URL: pasá por `vertexCuentaFor(usuario)` (cuentaVertex.ts).
     */
    project: env("GOOGLE_CLOUD_PROJECT"),
    /**
     * `global` y NO una region. No es un detalle de performance: es lo que hace
     * que exista la mitad de MODEL_CATALOG.
     *
     * Verificado con requests reales el 2026-08-27. Toda la familia Gemini 3.x
     * (3.6 Flash de chat, 3 Pro Image, 3.1 Flash Image, 3.1 Flash-Lite Image)
     * devuelve 404 en us-central1, us-east5 y europe-west4, y responde OK en
     * `global`. Solo los modelos 2.5 andaban en las regiones.
     *
     * Veo tambien funciona en `global`, ciclo completo verificado (start del LRO,
     * polling con fetchPredictOperation y bytes de vuelta). En us-east5 y
     * europe-west4 da 404.
     *
     * Ademas Google recomienda `global` justamente para reducir los 429: adentro
     * rutea a la region con mas capacidad disponible, que es un pool multi-region
     * mas grande que cualquier region sola.
     *
     * SI ALGUIEN LO VUELVE A PONER EN UNA REGION, los modelos 3.x empiezan a
     * fallar con 404 en cada job. `vertexBaseUrl()` ya resuelve el host distinto
     * que necesita `global` (aiplatform.googleapis.com, sin prefijo).
     */
    location: env("GOOGLE_CLOUD_LOCATION", "global"),
  },

  /**
   * Modelos por defecto (configurables por env y por proyecto via la UI).
   * Verifica los IDs vigentes en la doc oficial de Vertex AI.
   */
  models: {
    // Los tres defaults TIENEN que estar en MODEL_CATALOG (ver su comentario).
    // Gemini para interpretar el brief -> PlanJSON estructurado.
    llm: env("LLM_MODEL", "gemini-3.6-flash"),
    // Nano Banana (Gemini image) para text2image E image2image (consistencia de avatar).
    // La variante Flash y no Pro: es el equilibrio entre calidad y costo. Ni la Lite,
    // que devuelve imagenes de ~56 KB.
    image: env("IMAGE_MODEL", "gemini-3.1-flash-image"),
    // Veo para imagen->video (operacion de larga duracion / LRO).
    // Lite por default: es el mas barato de los tres. Los otros dos estan en el
    // selector.
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
    /**
     * Generacion por LOTES (solo en modo manual, autoApprove=false): maximo de jobs
     * del MISMO tipo "sin aprobar" (generando + esperando aprobacion) a la vez.
     * 0 = sin limite, arranca todo lo que se pueda hasta la concurrencia.
     *
     * Es un numero POR TIPO y no uno solo, porque las dos etapas no cuestan igual:
     *
     *  - IMAGENES (0, sin limite). El flujo del tablero es generar la tanda entera,
     *    revisarla en bloque y aprobarla. Con un limite de 5, importar 4 planes
     *    generaba 20 de 32 imagenes y se frenaba: habia que aprobar de a 5 para que
     *    siguiera, apretando el boton una y otra vez. Medido. Las imagenes son
     *    baratas, asi que el freno costaba trabajo manual sin ahorrar nada.
     *
     *  - VIDEOS (5). Aca el freno es a proposito y se queda: cada clip de Veo son
     *    varios USD y hay rate limit por minuto. Un tablero con 95 clips no puede
     *    comprometer todo el gasto de una; se revisan de a 5.
     *
     * PIPELINE_APPROVAL_BATCH (el nombre viejo, uno solo para los dos tipos) sigue
     * andando como fallback para no romper un .env que ya lo tenga seteado.
     */
    approvalBatchImages: Math.max(
      0,
      Number(
        env("PIPELINE_APPROVAL_BATCH_IMAGES", env("PIPELINE_APPROVAL_BATCH", "0"))
      )
    ),
    approvalBatchVideos: Math.max(
      0,
      Number(
        env("PIPELINE_APPROVAL_BATCH_VIDEOS", env("PIPELINE_APPROVAL_BATCH", "5"))
      )
    ),
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
    /**
     * Pausa ENTRE las variantes de una misma imagen (ms).
     *
     * No es cosmetica. Los modelos de imagen nuevos tienen la cuota muy apretada:
     * verificado el 2026-08-28, gemini-3.1-flash-image contesta 429
     * RESOURCE_EXHAUSTED a los ~200ms si se le manda la segunda variante pegada a
     * la primera. Sin esta pausa, pedir 2 variantes devolvia 1 sola.
     */
    imageVariantGapMs: Number(env("PIPELINE_IMAGE_VARIANT_GAP_MS", "2500")),
    /**
     * Reintentos RAPIDOS de una variante ante un 429, para absorber un rechazo
     * puntual. Son pocos y a proposito: la cuota de estos modelos es por MINUTO, y
     * esperar segundos no la resuelve (verificado). Cuando se agotan, el job se
     * devuelve a la cola, que espera `rateLimitBackoffMs` (45s) y al reintentar
     * genera SOLO las variantes que falten.
     */
    imageVariantRateLimitRetries: Number(
      env("PIPELINE_IMAGE_VARIANT_RETRIES", "2")
    ),
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
   * Cambio de voz (ElevenLabs Voice Changer sobre el video unido). Contrato de
   * tasks/cambio-de-voz/02-DISENO.md §5.
   *
   * La KEY no esta aca: la resuelve `elevenLabsKeyFor(usuario)` en cada llamada, porque
   * puede ser por usuario y porque no tiene que quedar en un objeto que se pueda
   * serializar por accidente a una respuesta.
   */
  voz: {
    /** Default "mock" (D16): el default no gasta. Cualquier valor raro tambien cae a mock. */
    proveedor: (env("VOICE_PROVIDER", "mock") === "elevenlabs" ? "elevenlabs" : "mock") as
      | "mock"
      | "elevenlabs",
    elevenlabs: {
      /** Sin "/" final: los paths se pegan con "/v1/...". */
      baseUrl: env("ELEVENLABS_BASE_URL", "https://api.elevenlabs.io").replace(/\/+$/, ""),
      modelo: env("ELEVENLABS_STS_MODEL", "eleven_multilingual_sts_v2"),
      /**
       * Solo mp3_* o wav_* (D20): vienen con contenedor y ffmpeg los lee solos. Un
       * pcm_* es audio crudo SIN cabecera, y leerlo obliga a adivinar frecuencia y
       * canales: un error ahi no falla, deja la voz acelerada o lenta. Cualquier otra
       * cosa cae al default, que acepta todo plan (wav_44100 pide Pro: medido en T00).
       */
      formatoSalida: /^(mp3|wav)_/.test(env("ELEVENLABS_OUTPUT_FORMAT"))
        ? env("ELEVENLABS_OUTPUT_FORMAT")
        : "mp3_44100_128",
      timeoutMs: envAcotado("ELEVENLABS_TIMEOUT_MS", 180000, 10000, 900000),
    },
    /** Largo maximo de un tramo (D4). 270 deja margen bajo el tope de 300 s de ElevenLabs. */
    tramoMaxSeg: envAcotado("VOICE_CHUNK_MAX_SEC", 270, 30, 290),
    /** Largo de "Probar 20 s" (R4). */
    pruebaSeg: envAcotado("VOICE_PREVIEW_SEC", 20, 5, 60),
    /** Recorte al inicio de cada salida, si ElevenLabs agrega un corrimiento fijo (T00 midio 0). */
    offsetMs: envAcotado("VOICE_OFFSET_MS", 0, 0, 500),
    /**
     * Como estimar creditos. Default "por_minuto": muestra el MAXIMO posible, asi el
     * numero real nunca sorprende para arriba (P-01 sin medir todavia).
     */
    facturacion: (env("VOICE_BILLING", "por_minuto") === "proporcional"
      ? "proporcional"
      : "por_minuto") as "por_minuto" | "proporcional",
    /** Solo informativo, para el costo que muestra el dialogo. */
    precioPorMinUsd: Number(env("PRICE_VOICE_PER_MIN_USD", "0.12")) || 0.12,
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

/**
 * API key de ElevenLabs para un usuario: `ELEVENLABS_API_KEY_<NOMBRE>` pisa a la
 * compartida `ELEVENLABS_API_KEY`, con el mismo patron que `PASSWORD_<NOMBRE>`. ""
 * si no hay ninguna.
 *
 * NO se cachea, por lo mismo que `authUsers()`: en el build de Next las vars de runtime
 * no existen, y un valor cacheado vacio dejaria el modulo "sin configurar" para siempre.
 *
 * Este es el UNICO lugar de src/ que lee el valor de la key (chequeo A2 de
 * tasks/cambio-de-voz/_verificacion-voz.sh). Nunca la loguees ni la devuelvas.
 */
export function elevenLabsKeyFor(usuario: string): string {
  return (
    process.env[`ELEVENLABS_API_KEY_${usuario.toUpperCase()}`] ||
    process.env.ELEVENLABS_API_KEY ||
    ""
  );
}

/** Cuenta de Google Cloud con la que genera un usuario: lo que sale por ella se factura a `proyecto`. */
export interface CuentaVertex {
  /** Proyecto de GCP al que se factura y cuya cuota se gasta. "" si no hay ninguno. */
  proyecto: string;
  /**
   * Path al JSON de credenciales propio del usuario. "" = las compartidas, que salen
   * de ADC (`gcloud auth application-default login` en local,
   * `GOOGLE_APPLICATION_CREDENTIALS` en el server).
   */
  credenciales: string;
  /** El usuario si la cuenta es suya, `null` si es la compartida. */
  usuario: string | null;
  /**
   * De donde salio: "app" la cargo el usuario desde el header (cuentaVertex.ts),
   * "servidor" son sus vars `_<NOMBRE>` del .env, "compartida" las vars sin sufijo.
   */
  origen: "app" | "servidor" | "compartida";
}

/**
 * Cuenta de Vertex de un usuario SEGUN EL ENVIRONMENT: `GOOGLE_CLOUD_PROJECT_<NOMBRE>` y
 * `GOOGLE_APPLICATION_CREDENTIALS_<NOMBRE>` pisan a las compartidas, con el mismo patron
 * que `PASSWORD_<NOMBRE>` y `ELEVENLABS_API_KEY_<NOMBRE>`. `usuario` null (un proyecto
 * viejo sin dueño) usa la compartida.
 *
 * Hay UNA excepcion a "la propia pisa a la compartida": con JSON propio y sin proyecto
 * propio, `proyecto` queda VACIO y no cae al compartido. Si cayera, las credenciales de
 * uno generarian en el proyecto del otro (anda si tienen acceso, que entre socios es lo
 * normal) y la factura le llegaria a quien no genero nada, sin un solo error. Vacio,
 * `assertVertexConfig` corta antes de gastar y dice que var falta.
 *
 * La cuenta que el usuario carga desde la app pisa a todo esto: no llames a esta
 * funcion para generar, llamá a `vertexCuentaFor` (cuentaVertex.ts).
 *
 * NO se cachea, por lo mismo que `authUsers()`.
 */
export function vertexCuentaDelEnv(usuario: string | null): CuentaVertex {
  const nombre = usuario?.toUpperCase();
  const proyectoPropio = nombre ? env(`GOOGLE_CLOUD_PROJECT_${nombre}`) : "";
  const credencialesPropias = nombre ? env(`GOOGLE_APPLICATION_CREDENTIALS_${nombre}`) : "";
  if (proyectoPropio || credencialesPropias) {
    return {
      proyecto: proyectoPropio,
      credenciales: credencialesPropias,
      usuario,
      origen: "servidor",
    };
  }
  return { proyecto: config.google.project, credenciales: "", usuario: null, origen: "compartida" };
}

/** Valida que un id de modelo pertenezca al catalogo del tipo dado. Si no, usa el default. */
export function resolveModel(kind: ModelKind, requested?: string): string {
  if (requested && MODEL_CATALOG[kind].some((m) => m.id === requested)) {
    return requested;
  }
  return config.models[kind];
}

/** URL base de la API REST de Vertex AI para el proyecto de la cuenta y la region configurada. */
export function vertexBaseUrl(cuenta: CuentaVertex): string {
  const { location } = config.google;
  const host =
    location === "global"
      ? "aiplatform.googleapis.com"
      : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${cuenta.proyecto}/locations/${location}/publishers/google/models`;
}

/** Valida que la cuenta tenga lo necesario para llamar a Vertex. Lanza error claro si falta. */
export function assertVertexConfig(cuenta: CuentaVertex): void {
  if (cuenta.usuario && !cuenta.proyecto) {
    const nombre = cuenta.usuario.toUpperCase();
    throw new Error(
      `${cuenta.usuario} tiene credenciales propias (GOOGLE_APPLICATION_CREDENTIALS_${nombre}) ` +
        `pero falta GOOGLE_CLOUD_PROJECT_${nombre}. No se usa el proyecto compartido: ` +
        `se le facturaria a otra cuenta.`
    );
  }
  const missing: string[] = [];
  if (!cuenta.proyecto) missing.push("GOOGLE_CLOUD_PROJECT");
  if (!config.google.location) missing.push("GOOGLE_CLOUD_LOCATION");
  if (missing.length > 0) {
    throw new Error(
      `Faltan variables de entorno para Vertex AI: ${missing.join(", ")}. ` +
        `Configuralas en .env.local y corré 'gcloud auth application-default login', ` +
        `o que el usuario cargue su propia cuenta desde su nombre, arriba a la derecha. ` +
        `O usá PROVIDER_MODE=mock para probar sin credenciales.`
    );
  }
}
