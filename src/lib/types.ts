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
  /**
   * Modelo con el que se generó ESTA variante puntual. OPCIONAL: sin "prompt dual"
   * (el caso normal) todas las variantes de un job usan el mismo modelo, que ya se
   * ve en `JobRecord.model`, así que este campo queda undefined y no duplica nada.
   * Con "prompt dual" (ver `JobRecord.meta.variantPlan`) cada variante puede haber
   * usado un modelo distinto (Flash/Pro), y sin esto la UI no podría mostrar cuál
   * fue cuál.
   */
  model?: string;
  /**
   * Etiqueta corta del prompt usado en ESTA variante ("A" / "B"), solo con "prompt
   * dual". OPCIONAL por el mismo motivo que `model`: en el caso normal todas las
   * variantes comparten el prompt de la imagen y no hay nada que distinguir.
   */
  promptLabel?: string;
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
  /**
   * info extra para debug/UI (ej operationName de Veo).
   *
   * `meta.variantPlan?: VariantPlanEntry[]` — "prompt dual" del generador masivo
   * (ver `VariantPlanEntry` mas abajo). Vive en `meta` y no como campo propio de
   * `JobRecord` porque es un caso de uso especifico (una sola pantalla lo setea) y
   * agregar un campo nuevo al tipo central para eso obligaria a tocarlo en todos los
   * lugares que construyen un JobRecord "a mano" (tests, providers/mock, etc), la
   * mayoria de los cuales nunca lo va a usar.
   */
  meta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Una entrada del "prompt dual" del generador masivo: que PROMPT y que MODELO usar
 * para la variante en esa posicion (1-based, coincide con `Candidate.index`).
 *
 * Contrato con `runImageGeneration` (jobs/pipeline.ts): si `job.meta.variantPlan` es
 * un array de esta forma, la variante `i` usa `variantPlan[i-1]` en vez de
 * `img.prompt` / `job.modelOverride || project.models.image` (el comportamiento de
 * SIEMPRE). Si `meta.variantPlan` no esta presente, o el array no cubre el indice `i`,
 * cae al comportamiento normal para esa variante — asi un plan corto (ej. 2 entradas
 * pedido con `variants: 4`) no revienta, genera las que faltan con el prompt/modelo
 * del job como si no hubiera plan.
 */
export interface VariantPlanEntry {
  prompt: string;
  model: string;
  /** etiqueta corta para la UI ("A" / "B"). No afecta la generacion. */
  label?: string;
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

/**
 * FASE de produccion del proyecto. Sirve para separar el gasto/rate limit en dos
 * tandas y poder revisar todo antes de tocar Veo:
 *  - "images": la cola SOLO corre jobs de imagen. Los videos quedan pendientes aunque
 *    su imagen ya este aprobada (si no, aprobar una imagen disparaba su video al toque).
 *  - "videos": corre todo (imagenes que falten + videos).
 * `undefined` = sin fase (comportamiento historico: corre todo). Los proyectos creados
 * por importacion en lote arrancan en "images".
 */
export type ProjectStage = "images" | "videos";

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
  /**
   * Formato de las imagenes del proyecto (imageConfig.aspectRatio de Vertex).
   * undefined = proyecto viejo, cae al default global 9:16.
   */
  imageAspectRatio?: string;
  /**
   * Calidad de las imagenes: "1K" | "2K" | "4K" (imageConfig.imageSize).
   * undefined = proyecto viejo, cae a 1K, que es el default de la API.
   */
  imageSize?: string;
  /**
   * Override del auto-approve por PROYECTO. Si es undefined, se usa el default
   * global (config.pipeline.autoApprove). Permite que cada proyecto elija:
   * - true  -> cada imagen/video se aprueba sola al terminar (modo "dejar correr").
   * - false -> cada job queda en awaiting_approval esperando al usuario.
   * Tipico: VSL con muchos clips => true; videos normales => false.
   */
  autoApprove?: boolean;
  /**
   * Usuario dueño del proyecto (el nombre de `PASSWORD_<NOMBRE>`, en minusculas).
   *
   * OPCIONAL a proposito: hace que el cambio sea aditivo y que los proyectos que ya
   * existian no rompan el tipo. `undefined` NO significa "de todos": el filtro es
   * `p.owner === usuario`, asi que un proyecto sin dueño queda invisible para todos
   * hasta que corra `scripts/migrar-owner.mjs`. Ver D2 de
   * tasks/aislamiento-por-usuario/00-PLAN-AISLAMIENTO-USUARIO.md.
   */
  owner?: string;
  /**
   * Info de la tanda del generador masivo de variaciones (/imagenes, pestaña
   * "Generador masivo"), si este proyecto se creo como parte de una. `undefined` =
   * proyecto suelto de siempre (el 100% de los casos hasta ahora).
   *
   * Se persiste en el PROYECTO (no solo en el estado en memoria de
   * `jobs/masivo.ts`) para que la UI pueda agrupar los N proyectos de una corrida
   * despues de un reinicio del proceso: la cola secuencial en memoria se pierde al
   * reiniciar (igual que toda la cola), pero el AGRUPAMIENTO visual de "estas 10
   * imagenes salieron de la misma tanda" tiene que sobrevivir, aunque la tanda ya
   * no se autoavance sola tras el reinicio.
   */
  batch?: {
    /** id compartido por los N proyectos de una misma corrida. */
    batchId: string;
    /** posicion 0-based dentro de la tanda (orden de las fotos subidas). */
    position: number;
    /** cuantos proyectos tiene la tanda en total. */
    total: number;
  };
  /**
   * Fase actual: "images" frena los jobs de video hasta que el usuario pase a "videos".
   * undefined = sin fase (corre todo, como siempre).
   */
  stage?: ProjectStage;
  /**
   * Receta del video unido: que clips entraron, en que orden, donde cae cada uno y la
   * huella de cada archivo. La escribe el stitch (T04 del cambio de voz).
   *
   * OPCIONAL a proposito, mismo criterio que `owner?`: si fuera obligatorio, tsc
   * romperia en cada lugar que arma un ProjectRecord. `undefined` = el proyecto nunca
   * se unio, o se unio antes de este modulo; en ese caso el cambio de voz pide volver
   * a unir una vez en lugar de adivinar la receta (D7 de tasks/cambio-de-voz/02-DISENO.md).
   */
  recetaUnido?: RecetaUnido;
  /**
   * Versiones del unido con otra voz, la MAS NUEVA PRIMERO. Opcional por lo mismo que
   * `recetaUnido?`: los proyectos que no usan la funcion no ganan el campo.
   */
  versionesVoz?: VersionDeVoz[];
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
  final_video: string | null; // "<nombre-del-proyecto>.mp4" si se hizo stitch
  warnings: string[];
}

/* ─────────────────────── cambio de voz (ElevenLabs) ─────────────────────── */
/*
  Contrato de tasks/cambio-de-voz/02-DISENO.md §4. Viven aca y no en src/lib/voz/ porque
  la UI los importa: el cliente trae TIPOS de types.ts y nunca un modulo que arrastra
  node:fs o la config con la key.
*/

/** Ajustes de la voz, en el rango 0..1. Se mapean 1:1 a `voice_settings` de ElevenLabs. */
export interface AjustesDeVoz {
  estabilidad: number;      // stability
  similitud: number;        // similarity_boost
  estilo: number;           // style
  realceHablante: boolean;  // use_speaker_boost
}

/**
 * Un clip tal cual entro al unido. Sin esto no se sabe donde cae cada clip dentro del
 * unido (para conservar los que no se convierten) ni si el clip cambio despues de unir.
 */
export interface ClipEnReceta {
  id: string;
  assetId: string;          // hoy no se usa: habilita "una voz por persona" sin volver a unir (D3)
  etiqueta: string;         // "IA" | "FILMAR_REAL"
  conDialogo: boolean;      // clip.dialogo.trim() !== "" al momento de unir
  file: string;             // path relativo, ej "clips/03_c3.mp4"
  mtimeMs: number;          // Math.trunc(stat.mtimeMs) ANTES de correr ffmpeg
  bytes: number;
  inicioSeg: number;        // dentro del unido
  finSeg: number;
}

/** Lo que el stitch deja anotado al unir (D6). */
export interface RecetaUnido {
  file: string;             // el unido, relativo: "<slug>.mp4"
  creadoEn: string;         // ISO. Identifica ESTE unido (las versiones lo guardan)
  duracionSeg: number;      // = finSeg del ultimo clip
  clips: ClipEnReceta[];    // en orden
}

/** Lo que la UI necesita saber del unido. */
export interface EstadoUnido {
  existe: boolean;
  file: string | null;
  conReceta: boolean;
  desactualizado: boolean;
  motivo: string | null;    // en castellano, listo para mostrar
  creadoEn: string | null;  // RecetaUnido.creadoEn, o null sin receta
}

/** Ciclo de vida de una version de voz (§10.3 del diseño). */
export type EstadoVersionDeVoz =
  | "en_cola" | "procesando" | "lista" | "fallida" | "cancelada";

/** Un .mp4 nuevo: el mismo video que el unido con el audio en otra voz. */
export interface VersionDeVoz {
  id: string;                               // randomUUID()
  voz: { id: string; nombre: string };      // nombre = alias o nombre de la voz AL CONVERTIR
  proveedor: "mock" | "elevenlabs";
  modelo: string | null;                    // el que devolvio el proveedor
  ajustes: AjustesDeVoz | null;             // null = los que la voz tiene guardados en ElevenLabs
  quitarRuido: boolean;
  incluirFilmados: boolean;
  prueba: boolean;
  estado: EstadoVersionDeVoz;
  progreso: { tramosListos: number; tramosTotal: number };
  segundosConvertidos: number;
  file: string | null;                      // relativo: "voz/<...>.mp4", solo con estado "lista"
  bytes: number | null;
  error: string | null;
  recetaCreadaEn: string;                   // RecetaUnido.creadoEn sobre la que se hizo
  bootId: string;                           // D12
  usuario: string;                          // quien la pidio
  creadoEn: string;
  actualizadoEn: string;
}

/** Una voz como la muestra la UI, normalizada desde ElevenLabs o el mock. */
export interface VozResumen {
  id: string;
  nombre: string;
  categoria: string | null;                 // premade | cloned | generated | professional | ...
  etiquetas: Record<string, string>;        // labels tal cual: accent, gender, age, use_case...
  descripcion: string | null;
  previewUrl: string | null;                // SOLO https; cualquier otra cosa -> null
  esPropia: boolean;
}

/** Una voz marcada en la APP (no en ElevenLabs), por usuario, con alias y ajustes (D14). */
export interface VozFavorita {
  voiceId: string;
  proveedor: "mock" | "elevenlabs";
  alias: string;                            // 1..60 caracteres
  ajustes: AjustesDeVoz | null;
  agregadaEn: string;
}

/** Una fila del selector: la voz + su favorita, si la hay. */
export interface VozEnLista extends VozResumen {
  favorita: VozFavorita | null;
  disponible: boolean;                      // false = favorita que ya no esta en la cuenta
}

/** Creditos de la cuenta de ElevenLabs. Best-effort: la key puede no tener user_read. */
export interface CreditosDeVoz {
  usados: number;
  limite: number;
  seRenuevaEn: string | null;               // ISO
  plan: string | null;
}

/** Lo que se muestra antes de confirmar: segundos, tramos y costo (R9). */
export interface EstimacionDeVoz {
  segundos: number;
  tramos: number;
  creditos: number;
  usd: number;
}

/** GET /api/projects/:id/voz */
export interface RespuestaEstadoVoz {
  proveedor: "mock" | "elevenlabs";
  disponible: boolean;
  motivoNoDisponible: string | null;
  unido: EstadoUnido;
  estimacion: {
    sinFilmados: EstimacionDeVoz;
    conFilmados: EstimacionDeVoz | null;    // null si no hay FILMAR_REAL con dialogo
    prueba: EstimacionDeVoz;
  } | null;                                 // null sin receta vigente
  filmadosConDialogo: number;
  versiones: VersionDeVoz[];                // la mas nueva primero
  activa: VersionDeVoz | null;
}

/** GET /api/voces */
export interface RespuestaVoces {
  proveedor: "mock" | "elevenlabs";
  voces: VozEnLista[];
  siguiente: string | null;
  creditos: CreditosDeVoz | null;
}

/* ─── Cuenta de Vertex por usuario (src/lib/cuentaVertex.ts) ─────────────── */

/**
 * La cuenta de Vertex de un usuario, como la ve la UI (GET /api/cuenta-vertex). NUNCA
 * trae la llave ni el path al JSON: solo lo que hace falta para que cada uno sepa a
 * quien se le factura lo que genera.
 */
export interface EstadoCuentaVertex {
  /** "mock": la app no llama a Vertex, asi que la cuenta todavia no se usa. */
  modo: "mock" | "vertex";
  /**
   * "app" = la cargo el usuario desde el header, "servidor" = la configuro el admin en
   * el .env (`GOOGLE_CLOUD_PROJECT_<NOMBRE>`), "compartida" = la de todos, "ninguna" =
   * no tiene propia y no hay compartida: no puede generar.
   */
  origen: "app" | "servidor" | "compartida" | "ninguna";
  proyecto: string | null;
  /** Email de la cuenta de servicio. null si es un login de gcloud o no se sabe. */
  email: string | null;
  tipo: "service_account" | "authorized_user" | null;
  /** ISO. Solo en "app". */
  cargadaEn: string | null;
}

/**
 * Resultado de probar una cuenta (POST /api/cuenta-vertex). `ayuda` lleva al lugar de
 * la consola de Google donde se arregla lo que fallo.
 */
export type PruebaCuentaVertex =
  | { ok: true }
  | { ok: false; motivo: string; ayuda: { texto: string; url: string } | null };

/* ─── Preferencias por usuario (src/lib/preferencias.ts) ─────────────────── */

/** GET y PUT /api/preferencias. */
export interface PreferenciasDeUsuario {
  /**
   * Clips de video que se generan SIN APROBAR antes de frenar, en los proyectos con
   * aprobacion manual. 0 = sin limite: genera todos de una.
   */
  loteVideos: number;
  /** El que rige si el usuario no eligio uno (`PIPELINE_APPROVAL_BATCH_VIDEOS`). */
  loteVideosDefault: number;
  /** true si el usuario eligio el suyo; false si rige el default. */
  loteVideosPropio: boolean;
}
