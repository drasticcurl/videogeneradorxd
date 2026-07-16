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

export interface EditProgressView {
  porcentaje: number;
  pasoActual: string;
  mensaje: string;
  status: string;
  error: { paso: string; motivo: string } | null;
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
  return {
    porcentaje: typeof nested.porcentaje === "number" ? nested.porcentaje : 0,
    pasoActual: typeof nested.pasoActual === "string" ? nested.pasoActual : "",
    mensaje: typeof nested.mensaje === "string" ? nested.mensaje : "",
    status: typeof value.status === "string" ? value.status : "running",
    error: parseProgressError(nested.error),
  };
}

function parseProgressError(raw: unknown): { paso: string; motivo: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const error = raw as Record<string, unknown>;
  if (typeof error.paso !== "string" || typeof error.motivo !== "string") return null;
  return { paso: error.paso, motivo: error.motivo };
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
