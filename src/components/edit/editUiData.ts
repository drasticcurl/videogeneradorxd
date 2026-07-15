export {
  MAX_MUSIC_UPLOAD_BYTES as MAX_MUSIC_BYTES,
  MUSIC_FILE_ACCEPT,
} from "@/lib/edit/musicUpload";
import { MAX_MUSIC_UPLOAD_BYTES } from "@/lib/edit/musicUpload";

export interface EditProgressView {
  porcentaje: number;
  pasoActual: string;
  mensaje: string;
  status: string;
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
  };
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
