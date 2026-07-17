export {
  MAX_MUSIC_UPLOAD_BYTES as MAX_MUSIC_BYTES,
  MUSIC_FILE_ACCEPT,
} from "@/lib/edit/musicUpload";
import { MAX_MUSIC_UPLOAD_BYTES } from "@/lib/edit/musicUpload";
import type {
  EditorSilenciosResponse,
  EditorSubtitulosResponse,
  EditorRenderResponse,
  EditorTextoExtra,
} from "@/lib/edit/editorClient";

/**
 * Correlation identifiers that tie a progress observation to a concrete build,
 * revision, and job pair. The backend does not emit these yet (that arrives in
 * later tasks); every field is optional so parsing degrades cleanly to the
 * current behavior when they are absent.
 */
export interface ProgressCorrelation {
  version?: string;
  revision?: string;
  editJobId?: string;
  editorJobId?: string;
}

export interface EditProgressView {
  porcentaje: number;
  pasoActual: string;
  /**
   * Current substep within `pasoActual`. Optional — omitted (undefined) when the
   * backend does not report it, so multiple substeps at the same percentage
   * (e.g. several distinct events at 25%) can still be told apart when present.
   */
  subpaso?: string;
  mensaje: string;
  status: string;
  /** Raw editor estado when reported (independent of the numeric percentage). */
  estado?: string;
  /** Correlation identifiers when the backend provides them. */
  correlation?: ProgressCorrelation;
  error: { paso: string; subpaso?: string; motivo: string } | null;
}

export interface EditOutputView {
  editJobId: string;
  outputKey: string;
  completedAt: string;
}

export function parseProgressResponse(data: unknown): EditProgressView {
  const value = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const nested = value.progress && typeof value.progress === "object"
    ? value.progress as Record<string, unknown>
    : {};
  const view: EditProgressView = {
    porcentaje: typeof nested.porcentaje === "number" ? nested.porcentaje : 0,
    pasoActual: typeof nested.pasoActual === "string" ? nested.pasoActual : "",
    mensaje: typeof nested.mensaje === "string" ? nested.mensaje : "",
    status: typeof value.status === "string" ? value.status : "running",
    error: parseProgressError(nested.error),
  };

  // Tolerant, additive fields. Each is attached only when actually present so
  // the returned view is byte-for-byte identical to the legacy shape otherwise
  // (undefined keys are ignored by structural equality).
  const subpaso = firstString(nested.subpaso, nested.subPaso);
  if (subpaso !== undefined) view.subpaso = subpaso;

  const estado = firstString(nested.estado, value.estado);
  if (estado !== undefined) view.estado = estado;

  const correlation = parseCorrelation(value, nested);
  if (correlation) view.correlation = correlation;

  return view;
}

/** Returns the first argument that is a non-empty string, else undefined. */
function firstString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

/**
 * Extracts correlation identifiers from either the top-level response or the
 * nested progress object. Returns undefined when none are present so callers
 * degrade cleanly to the current (no-correlation) behavior.
 */
function parseCorrelation(
  value: Record<string, unknown>,
  nested: Record<string, unknown>,
): ProgressCorrelation | undefined {
  const version = firstString(value.version, nested.version);
  const revision = firstString(value.revision, nested.revision, value.kRevision, nested.kRevision);
  const editJobId = firstString(value.editJobId, nested.editJobId);
  const editorJobId = firstString(value.editorJobId, nested.editorJobId);

  const correlation: ProgressCorrelation = {};
  if (version !== undefined) correlation.version = version;
  if (revision !== undefined) correlation.revision = revision;
  if (editJobId !== undefined) correlation.editJobId = editJobId;
  if (editorJobId !== undefined) correlation.editorJobId = editorJobId;

  return Object.keys(correlation).length > 0 ? correlation : undefined;
}

function parseProgressError(
  raw: unknown,
): { paso: string; subpaso?: string; motivo: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const error = raw as Record<string, unknown>;
  if (typeof error.paso !== "string" || typeof error.motivo !== "string") return null;
  const result: { paso: string; subpaso?: string; motivo: string } = {
    paso: error.paso,
    motivo: error.motivo,
  };
  const subpaso = firstString(error.subpaso, error.subPaso);
  if (subpaso !== undefined) result.subpaso = subpaso;
  return result;
}

export function parseOutputListResponse(data: unknown): EditOutputView[] {
  if (!data || typeof data !== "object") return [];
  const outputs = (data as { outputs?: unknown }).outputs;
  if (!Array.isArray(outputs)) return [];
  return outputs.filter((item): item is EditOutputView => {
    if (!item || typeof item !== "object") return false;
    const output = item as Record<string, unknown>;
    return typeof output.editJobId === "string"
      && typeof output.outputKey === "string"
      && typeof output.completedAt === "string";
  });
}

export function apiErrorMessage(data: unknown, status: number): string {
  if (typeof data === "string" && data.trim()) return data;
  if (data && typeof data === "object") {
    const error = (data as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message;
    }
  }
  return `Error ${status}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function encodeMusicFile(file: File): Promise<{
  data: string;
  mimeType: string;
  fileName: string;
}> {
  if (file.size <= 0) throw new Error("El archivo de música está vacío.");
  if (file.size > MAX_MUSIC_UPLOAD_BYTES) {
    throw new Error("El archivo de música supera el máximo de 20 MB.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return {
    data: bytesToBase64(bytes),
    mimeType: file.type || "application/octet-stream",
    fileName: file.name,
  };
}


// ---------------------------------------------------------------------------
// Generator-normalized pause views (camelCase, what the UI consumes)
//
// The editor-internal `video_url` (which points at the loopback backend host)
// is never sent to the browser; it is rewritten to a BFF preview reference
// `/api/edit/{editJobId}/preview/{video_nombre}`.
// ---------------------------------------------------------------------------

export interface SubtitleGroupView {
  texto: string;
  inicioS: number;
  finS: number;
}

export interface SilencesView {
  status: "awaiting_silences";
  editable: boolean;
  previewUrl: string | null;
  durationS: number;
  fps: number;
  width: number;
  height: number;
  segments: { inicioS: number; finS: number }[];
}

export interface SubtitlesView {
  status: "awaiting_subtitles";
  editable: boolean;
  groups: SubtitleGroupView[];
}

export interface FinalRenderView {
  status: "awaiting_final_render";
  editable: boolean;
  previewUrl: string | null;
  durationS: number | null;
  fps: number;
  width: number;
  height: number;
  groups: SubtitleGroupView[];
  extraTexts: EditorTextoExtra[];
}

/**
 * Builds the BFF preview URL for an intermediate video, or null when the
 * editor did not report a video name.
 */
export function buildPreviewUrl(
  editJobId: string,
  videoNombre: string | null | undefined,
): string | null {
  if (!videoNombre) return null;
  return `/api/edit/${editJobId}/preview/${videoNombre}`;
}

/** Normalizes GET /silencios/{id} → SilencesView. */
export function parseSilencesResponse(
  editJobId: string,
  data: EditorSilenciosResponse,
): SilencesView {
  return {
    status: "awaiting_silences",
    editable: Boolean(data.editable),
    previewUrl: buildPreviewUrl(editJobId, data.video_nombre),
    durationS: typeof data.duracion_s === "number" ? data.duracion_s : 0,
    fps: typeof data.fps === "number" ? data.fps : 0,
    width: typeof data.ancho === "number" ? data.ancho : 0,
    height: typeof data.alto === "number" ? data.alto : 0,
    segments: Array.isArray(data.tramos)
      ? data.tramos.map((t) => ({ inicioS: t.inicio_s, finS: t.fin_s }))
      : [],
  };
}

/** Normalizes GET /subtitulos/{id} → SubtitlesView (timings read-only). */
export function parseSubtitulosResponse(
  data: EditorSubtitulosResponse,
): SubtitlesView {
  return {
    status: "awaiting_subtitles",
    editable: Boolean(data.editable),
    groups: Array.isArray(data.grupos)
      ? data.grupos.map((g) => ({
          texto: g.texto,
          inicioS: g.inicio_s,
          finS: g.fin_s,
        }))
      : [],
  };
}

/** Normalizes GET /render/{id} → FinalRenderView. */
export function parseRenderResponse(
  editJobId: string,
  data: EditorRenderResponse,
): FinalRenderView {
  return {
    status: "awaiting_final_render",
    editable: Boolean(data.editable),
    previewUrl: buildPreviewUrl(editJobId, data.video_nombre),
    durationS: typeof data.duracion_s === "number" ? data.duracion_s : null,
    fps: typeof data.fps === "number" ? data.fps : 0,
    width: typeof data.ancho === "number" ? data.ancho : 0,
    height: typeof data.alto === "number" ? data.alto : 0,
    groups: Array.isArray(data.grupos)
      ? data.grupos.map((g) => ({
          texto: g.texto,
          inicioS: g.inicio_s,
          finS: g.fin_s,
        }))
      : [],
    extraTexts: Array.isArray(data.textos_extra) ? data.textos_extra : [],
  };
}


// ---------------------------------------------------------------------------
// Confirmation payload builders (shared by the edit components and their tests)
// ---------------------------------------------------------------------------

import type { SilenceSegment } from "@/lib/edit/validateSegments";

/** Body sent to POST /api/edit/{id}/silences. */
export function buildSilencesPayload(segments: SilenceSegment[]): {
  segments: SilenceSegment[];
} {
  return { segments };
}

/** Body sent to POST /api/edit/{id}/subtitles (text-only, count preserved). */
export function buildSubtitlesPayload(texts: string[]): {
  groups: { texto: string }[];
} {
  return { groups: texts.map((texto) => ({ texto })) };
}

/** Body sent to POST /api/edit/{id}/render (max 2 extra texts, motor pinned). */
export function buildRenderPayload(extraTexts: EditorTextoExtra[]): {
  extraTexts: EditorTextoExtra[];
  motor: "remotion";
} {
  return { extraTexts, motor: "remotion" };
}

/** True when every group text is non-empty after trim. */
export function allGroupsNonEmpty(texts: string[]): boolean {
  return texts.length > 0 && texts.every((t) => t.trim().length > 0);
}


// ---------------------------------------------------------------------------
// Progress log accumulation (in-UI play-by-play for the edit flow)
//
// While an edit job runs, EditProgress accumulates a visible log. A new entry
// is appended only when the meaningful (status, pasoActual, porcentaje,
// mensaje) tuple changes — consecutive identical polls are deduped — and the
// list is capped to the most recent entries.
// ---------------------------------------------------------------------------

/** Cap on retained log entries (newest kept, oldest dropped). */
export const MAX_PROGRESS_LOG_ENTRIES = 50;

export interface ProgressLogEntry {
  /** Wall-clock stamp (HH:MM:SS) of when this change was observed. */
  time: string;
  porcentaje: number;
  pasoActual: string;
  /** Optional substep — a change here appends a new line even at the same %. */
  subpaso?: string;
  mensaje: string;
  status: string;
  /** Optional raw editor estado (independent of the percentage). */
  estado?: string;
  /** Optional correlation identifiers surfaced when the backend provides them. */
  correlation?: ProgressCorrelation;
}

/**
 * Two entries describe the same progress state (ignoring the timestamp). The
 * comparison key is the *meaningful* tuple: a change in substep or estado — even
 * while the percentage stays constant (e.g. 25%) — counts as a new state and is
 * NOT deduped, so distinct substeps produce distinct visible log lines.
 */
function sameProgressState(a: ProgressLogEntry, b: ProgressLogEntry): boolean {
  return (
    a.status === b.status &&
    a.pasoActual === b.pasoActual &&
    (a.subpaso ?? "") === (b.subpaso ?? "") &&
    (a.estado ?? "") === (b.estado ?? "") &&
    a.porcentaje === b.porcentaje &&
    a.mensaje === b.mensaje
  );
}

/**
 * Appends `entry` to `prev`, deduping when it repeats the last entry's state
 * and capping the result to the most recent MAX_PROGRESS_LOG_ENTRIES. Pure: it
 * never mutates `prev` and returns `prev` unchanged when the entry is a dupe.
 */
export function appendProgressLog(
  prev: ProgressLogEntry[],
  entry: ProgressLogEntry,
): ProgressLogEntry[] {
  const last = prev[prev.length - 1];
  if (last && sameProgressState(last, entry)) return prev;
  const next = [...prev, entry];
  if (next.length > MAX_PROGRESS_LOG_ENTRIES) {
    return next.slice(next.length - MAX_PROGRESS_LOG_ENTRIES);
  }
  return next;
}

/**
 * Formats a log entry as a single monospace line, e.g.
 * `[15:04:05] 25% UNIR — Uniendo y normalizando clips a 9:16 · running`.
 *
 * When present, the substep is shown next to the step (`UNIR › Detectando
 * silencios`) and correlation identifiers are appended as a compact suffix, so
 * the user sees exactly which substep is active even while the percentage stays
 * at 25%. When those optional fields are absent the line is identical to the
 * legacy format.
 */
export function formatProgressLogLine(entry: ProgressLogEntry): string {
  const paso = entry.pasoActual.trim();
  const subpaso = (entry.subpaso ?? "").trim();
  const mensaje = entry.mensaje.trim();
  const head = `[${entry.time}] ${entry.porcentaje}%`;
  const step = paso ? ` ${paso}` : "";
  const sub = subpaso ? ` › ${subpaso}` : "";
  const msg = mensaje ? ` — ${mensaje}` : "";
  const corr = formatCorrelationSuffix(entry.correlation);
  return `${head}${step}${sub}${msg} · ${entry.status}${corr}`;
}

/**
 * Compact, human-readable correlation suffix (e.g. ` · rev=abc123 · editor=job-9`).
 * Returns "" when there is nothing to show, keeping the legacy line unchanged.
 */
export function formatCorrelationSuffix(correlation?: ProgressCorrelation): string {
  if (!correlation) return "";
  const parts: string[] = [];
  if (correlation.version) parts.push(`v=${correlation.version}`);
  if (correlation.revision) parts.push(`rev=${correlation.revision}`);
  if (correlation.editorJobId) parts.push(`editor=${correlation.editorJobId}`);
  if (correlation.editJobId) parts.push(`job=${correlation.editJobId}`);
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

/**
 * A short, actionable recommendation for a terminal failure, keyed on the step
 * that failed. This lets the UI tell the user what to do next instead of only
 * showing the raw motive — so a stall that ends in failure is immediately
 * actionable.
 */
export function recommendedActionForError(
  error: { paso: string; subpaso?: string; motivo: string } | null,
): string {
  if (!error) return "";
  switch (error.paso) {
    case "EDITOR_STATE_LOST":
      return "El trabajo del editor se perdió (posible reinicio del servicio). Vuelve a enviar la edición.";
    case "STATUS_MAPPING":
      return "El editor devolvió un estado no reconocido. Verifica que el editor y el generador estén en la misma versión.";
    case "UNIR":
      return "Falló la unión de clips. Revisa las versiones de ffmpeg/ffprobe y los clips de origen, luego reintenta.";
    case "CORTAR_SILENCIOS":
      return "Falló la detección de silencios. Revisa el video unido y reintenta la edición.";
    default:
      return "Revisa el motivo indicado y reintenta la edición; si persiste, revisa los logs correlacionados.";
  }
}


/** Which control surface EditProgress should render for a given status. */
export type EditControl =
  | "silence"
  | "subtitle"
  | "final"
  | "download"
  | "error"
  | "progress";

/**
 * Maps a generator status to the control EditProgress mounts. Every reachable
 * status yields a control/bar/download/error — the no-silent-hang guarantee.
 */
export function controlForStatus(status: string): EditControl {
  switch (status) {
    case "awaiting_silences":
      return "silence";
    case "awaiting_subtitles":
      return "subtitle";
    case "awaiting_final_render":
      return "final";
    case "completed":
      return "download";
    case "failed":
      return "error";
    default:
      return "progress";
  }
}

/**
 * Distinguishable UI mount event kind for a status (spec `unir-step-hang`,
 * Task 3.5, Change 4 #8). When the silence control mounts, the timeline is on
 * screen — surfaced as `timeline_mount` so an observer can confirm the pause
 * actually propagated to the UI (category C is resolved when this fires). Pure
 * and total: every status yields exactly one mount-event kind.
 */
export type EditMountEvent =
  | "timeline_mount"
  | "subtitle_review_mount"
  | "final_render_mount"
  | "download_mount"
  | "error_mount"
  | "progress_mount";

export function controlEventForStatus(status: string): EditMountEvent {
  switch (controlForStatus(status)) {
    case "silence":
      return "timeline_mount";
    case "subtitle":
      return "subtitle_review_mount";
    case "final":
      return "final_render_mount";
    case "download":
      return "download_mount";
    case "error":
      return "error_mount";
    default:
      return "progress_mount";
  }
}
