/**
 * VolumeStorageAdapter — Shared_Volume based storage for cloud mode.
 *
 * Uses the emptyDir Shared_Volume mounted in the Cloud Run multi-container service
 * for input exchange between the generator (ingress) and editor (sidecar) containers.
 *
 * - putInput writes inputs to Shared_Volume under edit-io/<editJobId>/inputs/.
 * - getOutputStream reads from edit-io/<editJobId>/outputs/ (Range-aware).
 * - persistOutput/signedGetUrl delegates to videogeneradorxd's existing storage module.
 *
 * When a source already resides in the existing storage (output dir), it is
 * materialized onto the Shared_Volume once.
 *
 * Enforce write-only under inputs/, read-only under outputs/.
 *
 * Requirements: 6, 7, 9
 */

import fsp from "node:fs/promises";
import path from "node:path";
import type { StorageAdapter } from "./storageAdapter";
import { deriveKey } from "./storageAdapter";

// ---------------------------------------------------------------------------
// Helpers — existing storage delegation
// ---------------------------------------------------------------------------

/**
 * Interface for delegating durable output persistence.
 * In production this wraps videogeneradorxd's existing storage utilities.
 */
export interface DurableStorage {
  /**
   * Persist a local file to the durable Output_Store.
   * @param localPath  Absolute path to the local file.
   * @param outputKey  The logical key under which to store it.
   * @returns The final storage key (may differ from outputKey if the store normalizes).
   */
  persist(localPath: string, outputKey: string): Promise<string>;

  /**
   * Generate a signed URL for direct GET access.
   * Returns undefined if not supported.
   */
  signedUrl(outputKey: string, ttlSec: number): Promise<string | undefined>;

  /**
   * Check if a source artifact exists in the existing storage.
   * @param key  The storage key (relative path).
   * @returns Absolute path if it exists locally / can be accessed, undefined otherwise.
   */
  resolve(key: string): Promise<string | undefined>;
}

// ---------------------------------------------------------------------------
// VolumeStorageAdapter
// ---------------------------------------------------------------------------

export class VolumeStorageAdapter implements StorageAdapter {
  private readonly volumeRoot: string;
  private readonly durableStorage: DurableStorage;

  /**
   * @param durableStorage  Delegate for persisting to the existing Output_Store.
   * @param volumeRoot      Root path of the shared volume (default from SHARED_VOLUME_PATH env or "/shared").
   */
  constructor(durableStorage: DurableStorage, volumeRoot?: string) {
    this.volumeRoot =
      volumeRoot ??
      (process.env.SHARED_VOLUME_PATH || "/shared");
    this.durableStorage = durableStorage;
  }

  /**
   * Resolve a derived key to an absolute path on the shared volume.
   */
  private absForKey(key: string): string {
    return path.join(this.volumeRoot, ...key.split("/"));
  }

  /**
   * Write an input buffer to the Shared_Volume under inputs/.
   * Enforces write-only to inputs/ prefix.
   */
  async putInput(
    editJobId: string,
    relKey: string,
    data: Uint8Array
  ): Promise<string> {
    const key = deriveKey(editJobId, "inputs", relKey);
    const abs = this.absForKey(key);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, data);
    return key;
  }

  /**
   * Materialize a source from existing storage onto the Shared_Volume inputs.
   * If the source is already materialized, this is a no-op.
   *
   * @param editJobId     The unique edit job identifier.
   * @param sourceKey     The key in the existing storage (e.g. "clips/01_intro.mp4").
   * @param targetRelKey  The filename to use in the inputs area.
   * @returns The full derived key on the volume.
   */
  async materializeFromExisting(
    editJobId: string,
    sourceKey: string,
    targetRelKey: string
  ): Promise<string> {
    const key = deriveKey(editJobId, "inputs", targetRelKey);
    const abs = this.absForKey(key);

    // Check if already materialized
    try {
      await fsp.access(abs);
      return key; // already exists, no-op
    } catch {
      // not yet materialized, proceed
    }

    // Resolve from existing storage
    const sourcePath = await this.durableStorage.resolve(sourceKey);
    if (!sourcePath) {
      throw new Error(
        `Source artifact "${sourceKey}" not found in existing storage`
      );
    }

    // Copy to shared volume
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.copyFile(sourcePath, abs);
    return key;
  }

  /**
   * Read output bytes from the Shared_Volume under outputs/.
   * Enforces read-only from outputs/ prefix. Supports Range-aware reads.
   */
  async getOutputStream(
    editJobId: string,
    relKey: string,
    range?: { start: number; end?: number }
  ): Promise<Uint8Array> {
    const key = deriveKey(editJobId, "outputs", relKey);
    const abs = this.absForKey(key);

    if (range) {
      const fd = await fsp.open(abs, "r");
      try {
        const stat = await fd.stat();
        const end = range.end !== undefined ? Math.min(range.end + 1, stat.size) : stat.size;
        const length = end - range.start;
        if (length <= 0) {
          return new Uint8Array(0);
        }
        const buffer = Buffer.alloc(length);
        await fd.read(buffer, 0, length, range.start);
        return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      } finally {
        await fd.close();
      }
    }

    const buf = await fsp.readFile(abs);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  /**
   * Persist a finished output from the Shared_Volume to the existing Output_Store.
   * Reads from outputs/ on the volume, delegates to durable storage.
   */
  async persistOutput(
    editJobId: string,
    relKey: string
  ): Promise<string | undefined> {
    const key = deriveKey(editJobId, "outputs", relKey);
    const abs = this.absForKey(key);

    try {
      await fsp.access(abs);
    } catch {
      return undefined;
    }

    // Persist to durable storage using the edit-output convention
    const outputKey = `edit-output/${editJobId}/${relKey}`;
    try {
      const storedKey = await this.durableStorage.persist(abs, outputKey);
      return storedKey;
    } catch {
      return undefined;
    }
  }

  /**
   * Generate a signed URL via the existing durable storage layer.
   */
  async signedGetUrl(
    outputKey: string,
    ttlSec: number
  ): Promise<string | undefined> {
    return this.durableStorage.signedUrl(outputKey, ttlSec);
  }
}
