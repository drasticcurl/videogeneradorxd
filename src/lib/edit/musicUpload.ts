/**
 * Music upload handling for the edit start flow.
 *
 * Validates optional music track format (reject unsupported with 400 and no upload).
 * Uploads to the inputs/ area via the storage adapter and returns the input key
 * only after upload succeeds. Omits the reference when no track is provided.
 *
 * Supported audio formats include MP3, WAV, OGG, FLAC, AAC, and M4A.
 *
 * Requirements: 2.2, 2.3, 2.5
 */

import type { StorageAdapter } from "./storageAdapter";

// ---------------------------------------------------------------------------
// Supported audio MIME types
// ---------------------------------------------------------------------------

export const MAX_MUSIC_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Set of audio MIME types accepted for music uploads.
 */
export const SUPPORTED_MUSIC_MIMES: ReadonlySet<string> = new Set([
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/flac",
  "audio/aac",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "application/x-m4a",
]);

const SUPPORTED_MUSIC_EXTENSIONS = new Set([
  ".mp3", ".wav", ".ogg", ".oga", ".flac", ".aac", ".m4a",
]);

export const MUSIC_FILE_ACCEPT = [
  ...SUPPORTED_MUSIC_MIMES,
  ...SUPPORTED_MUSIC_EXTENSIONS,
].join(",");

/**
 * Human-readable list of supported formats for error messages.
 */
export const SUPPORTED_MUSIC_FORMATS: readonly string[] = [
  "audio/mpeg (.mp3)",
  "audio/wav (.wav)",
  "audio/ogg (.ogg)",
  "audio/flac (.flac)",
  "audio/aac (.aac)",
  "audio/mp4, audio/m4a, audio/x-m4a, or application/x-m4a (.m4a)",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MusicUploadInput {
  /** Base64-encoded music data or raw Uint8Array. */
  data: Uint8Array;
  /** MIME type of the music file. */
  mimeType: string;
  /** Original filename (used as the key). */
  fileName: string;
}

export interface MusicUploadResult {
  /** Full storage key retained by the generator adapter. */
  inputKey?: string;
  /** Relative filename sent to FastAPI under edit-io/<id>/inputs. */
  editorKey?: string;
  /** Error message if validation/upload failed. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates whether the given MIME type is a supported audio format.
 * Returns null if valid, or an error message string if not.
 */
export function validateMusicFormat(
  mimeType: string,
  fileName?: string
): string | null {
  const normalizedMime = mimeType.trim().toLowerCase();
  const extension = fileName && fileName.includes(".")
    ? `.${fileName.split(".").pop()!.toLowerCase()}`
    : "";
  const genericMime = normalizedMime === "" || normalizedMime === "application/octet-stream";
  if (
    !SUPPORTED_MUSIC_MIMES.has(normalizedMime) &&
    !(genericMime && SUPPORTED_MUSIC_EXTENSIONS.has(extension))
  ) {
    return (
      `Unsupported music format "${mimeType || "unknown"}". ` +
      `Supported formats: ${SUPPORTED_MUSIC_FORMATS.join(", ")}.`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Upload handler
// ---------------------------------------------------------------------------

/**
 * Handles optional music track upload for an edit job.
 *
 * - If no music input is provided, returns { inputKey: undefined } (no-op).
 * - If the format is unsupported, returns { error } without uploading.
 * - On success, uploads to the adapter's inputs/ area and returns { inputKey }.
 *
 * @param editJobId  The edit job identifier (for storage namespacing).
 * @param music      Optional music input data.
 * @param adapter    The storage adapter to upload to.
 */
export async function handleMusicUpload(
  editJobId: string,
  music: MusicUploadInput | undefined,
  adapter: StorageAdapter,
  editorKey?: string
): Promise<MusicUploadResult> {
  // No track provided → omit reference (Req 2.3)
  if (!music) {
    return {};
  }

  // Validate format (Req 2.5)
  const formatError = validateMusicFormat(music.mimeType, music.fileName);
  if (formatError) {
    return { error: formatError };
  }

  // Upload to inputs/ — reference only after success (Req 2.2)
  const relativeKey = editorKey ?? music.fileName;
  const inputKey = await adapter.putInput(editJobId, relativeKey, music.data);
  return {
    inputKey,
    editorKey: await adapter.toEditorInputReference(editJobId, inputKey),
  };
}
