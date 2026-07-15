/**
 * Broll_Bank — storage, validation, and selection of reusable b-roll clips.
 *
 * Stores clips on disk under the project's data dir (broll/) with metadata
 * (unique id, name, duration in seconds, upload timestamp). Provides upload
 * validation (format + size) and selection resolution.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5
 */

import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config";
import { getMaxBrollBytes, getMaxClipsPerJob } from "./config";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Metadata for a single b-roll clip stored in the bank.
 */
export interface BrollClipMeta {
  /** Unique identifier for the clip. */
  id: string;
  /** Display name (original filename). */
  name: string;
  /** Duration of the clip in seconds (from ffprobe). */
  durationSec: number;
  /** ISO-8601 timestamp when the clip was uploaded. */
  uploadedAt: string;
}

/**
 * Result of a successful upload.
 */
export interface BrollUploadResult {
  id: string;
  name: string;
  durationSec: number;
  uploadedAt: string;
}

/**
 * Validation error with structured info.
 */
export interface BrollValidationError {
  code: "UNSUPPORTED_FORMAT" | "INVALID_SIZE";
  message: string;
  /** Only present for format errors — the set of supported formats. */
  supportedFormats?: string[];
  /** Only present for size errors — the allowed range. */
  allowedRange?: { min: number; max: number };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Supported video container MIME types for b-roll uploads.
 */
export const SUPPORTED_BROLL_MIMES: ReadonlySet<string> = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-matroska",
  "video/x-msvideo",
]);

/**
 * Supported video file extensions (used for display/error messages).
 */
export const SUPPORTED_BROLL_EXTENSIONS: readonly string[] = [
  "mp4",
  "webm",
  "mov",
  "mkv",
  "avi",
];

/**
 * Map from MIME type to canonical extension.
 */
const MIME_TO_EXT: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
  "video/x-msvideo": ".avi",
};

/**
 * Metadata filename stored alongside clips.
 */
const META_FILE = "broll_meta.json";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolves the broll storage directory. */
export function getBrollDir(overrideDataDir?: string): string {
  const dataDir = overrideDataDir ?? config.storage.dataDir;
  return path.join(dataDir, "broll");
}

/**
 * Probes the duration of a video file using ffprobe.
 * Returns duration in seconds (float).
 */
export async function probeDurationSec(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "quiet",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    filePath,
  ]);
  const dur = parseFloat(stdout.trim());
  if (!Number.isFinite(dur) || dur <= 0) {
    throw new Error(`Could not determine duration for: ${filePath}`);
  }
  return Math.round(dur * 100) / 100; // 2 decimal places
}

// ---------------------------------------------------------------------------
// BrollBank class
// ---------------------------------------------------------------------------

export class BrollBank {
  private readonly brollDir: string;
  private readonly metaPath: string;

  constructor(overrideDataDir?: string) {
    this.brollDir = getBrollDir(overrideDataDir);
    this.metaPath = path.join(this.brollDir, META_FILE);
  }

  /** Ensure the broll directory exists. */
  private async ensureDir(): Promise<void> {
    await fsp.mkdir(this.brollDir, { recursive: true });
  }

  /** Load all clip metadata from the meta file. */
  private async loadMeta(): Promise<BrollClipMeta[]> {
    try {
      const raw = await fsp.readFile(this.metaPath, "utf8");
      return JSON.parse(raw) as BrollClipMeta[];
    } catch {
      return [];
    }
  }

  /** Persist clip metadata to the meta file. */
  private async saveMeta(clips: BrollClipMeta[]): Promise<void> {
    await this.ensureDir();
    await fsp.writeFile(this.metaPath, JSON.stringify(clips, null, 2), "utf8");
  }

  /** Resolve the on-disk path for a clip by id + extension. */
  private clipPath(id: string, ext: string): string {
    return path.join(this.brollDir, `${id}${ext}`);
  }

  // -------------------------------------------------------------------------
  // Validation (sub-task 6.2)
  // -------------------------------------------------------------------------

  /**
   * Validate a b-roll upload's format and size.
   * Returns null if valid, or a BrollValidationError otherwise.
   */
  validateUpload(
    mimeType: string,
    sizeBytes: number
  ): BrollValidationError | null {
    // Format validation
    if (!SUPPORTED_BROLL_MIMES.has(mimeType)) {
      return {
        code: "UNSUPPORTED_FORMAT",
        message: `Unsupported video format. Supported formats: ${SUPPORTED_BROLL_EXTENSIONS.join(", ")}`,
        supportedFormats: [...SUPPORTED_BROLL_EXTENSIONS],
      };
    }

    // Size validation
    const maxBytes = getMaxBrollBytes();
    if (sizeBytes <= 0 || sizeBytes > maxBytes) {
      return {
        code: "INVALID_SIZE",
        message: `File size must be between 1 byte and ${maxBytes} bytes. Got ${sizeBytes} bytes.`,
        allowedRange: { min: 1, max: maxBytes },
      };
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Upload (sub-task 6.1)
  // -------------------------------------------------------------------------

  /**
   * Upload a b-roll clip: validates, stores to disk, probes duration, records metadata.
   *
   * @param fileName  Original file name (used as display name).
   * @param mimeType  MIME type of the uploaded file.
   * @param data      The raw file bytes.
   * @returns The upload result with clip metadata, or throws on validation failure.
   */
  async upload(
    fileName: string,
    mimeType: string,
    data: Uint8Array
  ): Promise<{ result?: BrollUploadResult; error?: BrollValidationError }> {
    // Validate
    const validationError = this.validateUpload(mimeType, data.byteLength);
    if (validationError) {
      return { error: validationError };
    }

    await this.ensureDir();

    const id = crypto.randomUUID();
    const ext = MIME_TO_EXT[mimeType] ?? ".mp4";
    const diskPath = this.clipPath(id, ext);

    // Write to disk
    await fsp.writeFile(diskPath, data);

    // Probe duration
    let durationSec: number;
    try {
      durationSec = await probeDurationSec(diskPath);
    } catch {
      // Clean up on probe failure
      await fsp.unlink(diskPath).catch(() => {});
      return {
        error: {
          code: "UNSUPPORTED_FORMAT",
          message: "Could not determine video duration. The file may be corrupted or not a valid video.",
          supportedFormats: [...SUPPORTED_BROLL_EXTENSIONS],
        },
      };
    }

    const uploadedAt = new Date().toISOString();

    // Record metadata
    const clips = await this.loadMeta();
    const meta: BrollClipMeta = { id, name: fileName, durationSec, uploadedAt };
    clips.push(meta);
    await this.saveMeta(clips);

    return {
      result: { id, name: fileName, durationSec, uploadedAt },
    };
  }

  // -------------------------------------------------------------------------
  // List (sub-task 6.1)
  // -------------------------------------------------------------------------

  /**
   * List all b-roll clips with their metadata.
   * Returns an array of BrollClipMeta entries.
   */
  async list(): Promise<BrollClipMeta[]> {
    return this.loadMeta();
  }

  // -------------------------------------------------------------------------
  // Selection / Resolution (sub-task 6.1)
  // -------------------------------------------------------------------------

  /**
   * Resolve a selection of clip IDs into input file paths.
   * Validates that:
   *  - All IDs exist in the bank.
   *  - Count is between 1 and MAX_CLIPS_PER_JOB.
   *
   * @param clipIds  Array of b-roll clip IDs to resolve.
   * @returns Object with resolved paths or an error message.
   */
  async resolve(
    clipIds: string[]
  ): Promise<{ paths?: string[]; error?: string }> {
    const maxClips = getMaxClipsPerJob();
    if (clipIds.length < 1 || clipIds.length > maxClips) {
      return {
        error: `Selection must contain between 1 and ${maxClips} clips. Got ${clipIds.length}.`,
      };
    }

    const clips = await this.loadMeta();
    const clipMap = new Map(clips.map((c) => [c.id, c]));

    const missing: string[] = [];
    const paths: string[] = [];

    for (const id of clipIds) {
      const meta = clipMap.get(id);
      if (!meta) {
        missing.push(id);
        continue;
      }
      // Find the file on disk (try all supported extensions)
      let found = false;
      for (const ext of Object.values(MIME_TO_EXT)) {
        const p = this.clipPath(id, ext);
        try {
          await fsp.access(p);
          paths.push(p);
          found = true;
          break;
        } catch {
          // try next extension
        }
      }
      if (!found) {
        missing.push(id);
      }
    }

    if (missing.length > 0) {
      return {
        error: `B-roll clips not found: ${missing.join(", ")}`,
      };
    }

    return { paths };
  }

  /**
   * Get the on-disk path for a single b-roll clip by id.
   * Returns undefined if the clip doesn't exist.
   */
  async getClipPath(id: string): Promise<string | undefined> {
    const clips = await this.loadMeta();
    const meta = clips.find((c) => c.id === id);
    if (!meta) return undefined;

    for (const ext of Object.values(MIME_TO_EXT)) {
      const p = this.clipPath(id, ext);
      try {
        await fsp.access(p);
        return p;
      } catch {
        // try next extension
      }
    }
    return undefined;
  }
}
