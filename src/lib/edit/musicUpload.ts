/**
 * Music upload handling for the edit start flow.
 *
 * Validates optional music track format (reject unsupported with 400 and no upload).
 * Uploads to the inputs/ area via the storage adapter and returns the input key
 * only after upload succeeds. Omits the reference when no track is provided.
 *
 * Supported audio formats: audio/mpeg, audio/wav, audio/ogg, audio/flac, audio/aac.
 *
 * Requirements: 2.2, 2.3, 2.5
 */

import type { StorageAdapter } from "./storageAdapter";

// ---------------------------------------------------------------------------
// Supported audio MIME types
// ---------------------------------------------------------------------------

/**
 * Set of audio MIME types accepted for music uploads.
 */
export const SUPPORTED_MUSIC_MIMES: ReadonlySet<string> = new Set([
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/flac",
  "audio/aac",
]);

/**
 * Human-readable list of supported formats for error messages.
 */
export const SUPPORTED_MUSIC_FORMATS: readonly string[] = [
  "audio/mpeg (.mp3)",
  "audio/wav (.wav)",
  "audio/ogg (.ogg)",
  "audio/flac (.flac)",
  "audio/aac (.aac)",
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
  /** The storage key of the uploaded music file (only set on success). */
  inputKey?: string;
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
export function validateMusicFormat(mimeType: string): string | null {
  if (!SUPPORTED_MUSIC_MIMES.has(mimeType)) {
    return (
      `Unsupported music format "${mimeType}". ` +
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
  adapter: StorageAdapter
): Promise<MusicUploadResult> {
  // No track provided → omit reference (Req 2.3)
  if (!music) {
    return {};
  }

  // Validate format (Req 2.5)
  const formatError = validateMusicFormat(music.mimeType);
  if (formatError) {
    return { error: formatError };
  }

  // Upload to inputs/ — reference only after success (Req 2.2)
  const inputKey = await adapter.putInput(editJobId, music.fileName, music.data);
  return { inputKey };
}
