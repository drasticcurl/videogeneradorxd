/**
 * StorageAdapter — abstraction for placing edit-job inputs and reading outputs.
 *
 * Two implementations:
 *  - LocalStorageAdapter: uses the project's output/<projectId>/ scratch (local mode).
 *  - VolumeStorageAdapter: uses the Shared_Volume (emptyDir) for input exchange
 *    and delegates durable output persistence to videogeneradorxd's existing storage.
 *
 * All keys are confined to the edit-io/<editJobId>/ prefix via deriveKey().
 *
 * Requirements: 7, 9
 */

import path from "node:path";

// ---------------------------------------------------------------------------
// StorageAdapter interface
// ---------------------------------------------------------------------------

/**
 * Abstraction consumed by the Editor_Handoff layer.
 */
export interface StorageAdapter {
  /**
   * Write an input buffer into the edit-job input area.
   * @param editJobId  The unique edit job identifier.
   * @param relKey     Relative filename within the inputs area (e.g. "clip_01.mp4").
   * @param data       The byte content.
   * @returns The full resolved key used for storage.
   */
  putInput(editJobId: string, relKey: string, data: Uint8Array): Promise<string>;

  /**
   * Get a readable byte buffer from the edit-job output area.
   * @param editJobId  The unique edit job identifier.
   * @param relKey     Relative filename within the outputs area (e.g. "final.mp4").
   * @param range      Optional byte range { start, end } for partial reads.
   * @returns The byte content (or a slice if range provided).
   */
  getOutputStream(
    editJobId: string,
    relKey: string,
    range?: { start: number; end?: number }
  ): Promise<Uint8Array>;

  /**
   * Persist a finished output to the durable Output_Store.
   * In local mode this is a no-op/copy within the project dir.
   * In cloud mode this delegates to the existing GCS storage layer.
   * @param editJobId  The unique edit job identifier.
   * @param relKey     Relative filename within the outputs area.
   * @returns The durable output key for later retrieval, or undefined on failure.
   */
  persistOutput(editJobId: string, relKey: string): Promise<string | undefined>;

  /**
   * Generate a signed URL for direct GET access to a persisted output.
   * Only supported in cloud mode. Returns undefined when not available.
   */
  signedGetUrl(outputKey: string, ttlSec: number): Promise<string | undefined>;
}

// ---------------------------------------------------------------------------
// Key derivation with path-traversal protection
// ---------------------------------------------------------------------------

/** Prefix used for all edit-job I/O namespacing. */
const EDIT_IO_PREFIX = "edit-io";

/**
 * Error thrown when a derived key would escape the permitted prefix.
 */
export class KeyConfinementError extends Error {
  constructor(editJobId: string, relKey: string) {
    super(
      `Key confinement violation: relKey "${relKey}" would escape ` +
        `the permitted prefix edit-io/${editJobId}/`
    );
    this.name = "KeyConfinementError";
  }
}

/**
 * Derives a confined storage key under edit-io/<editJobId>/<sub>/<relKey>.
 *
 * Rejects any relKey that:
 *  - contains ".." path segments (traversal)
 *  - is an absolute path (starts with "/" or a Windows drive letter)
 *  - uses backslash separators (Windows-ism leaking in)
 *  - is empty after normalization
 *
 * On success returns a POSIX-style key like "edit-io/abc123/inputs/clip_01.mp4".
 * On failure throws KeyConfinementError.
 *
 * @param editJobId  The unique edit job identifier.
 * @param sub        Sub-directory within the job namespace ("inputs" or "outputs").
 * @param relKey     The user-/system-supplied relative filename.
 */
export function deriveKey(
  editJobId: string,
  sub: "inputs" | "outputs",
  relKey: string
): string {
  // Reject obviously malicious patterns before normalizing
  if (!relKey || relKey.trim() === "") {
    throw new KeyConfinementError(editJobId, relKey);
  }

  // Reject backslashes (prevent Windows-style traversal)
  if (relKey.includes("\\")) {
    throw new KeyConfinementError(editJobId, relKey);
  }

  // Reject absolute paths
  if (path.isAbsolute(relKey) || /^[a-zA-Z]:/.test(relKey)) {
    throw new KeyConfinementError(editJobId, relKey);
  }

  // Reject ".." segments explicitly (before normalize could collapse them)
  const segments = relKey.split("/");
  for (const seg of segments) {
    if (seg === "..") {
      throw new KeyConfinementError(editJobId, relKey);
    }
  }

  // Normalize (removes redundant slashes and "." segments)
  const normalized = path.posix.normalize(relKey);

  // Double-check the normalized result doesn't escape
  if (normalized.startsWith("/") || normalized.startsWith("..")) {
    throw new KeyConfinementError(editJobId, relKey);
  }

  // Final check: the joined key must remain under the expected prefix
  const prefix = path.posix.join(EDIT_IO_PREFIX, editJobId, sub);
  const fullKey = path.posix.join(prefix, normalized);

  // Verify the full key starts with the prefix (defense-in-depth)
  if (!fullKey.startsWith(prefix + "/") && fullKey !== prefix) {
    throw new KeyConfinementError(editJobId, relKey);
  }

  return fullKey;
}
