/**
 * LocalStorageAdapter — filesystem-based storage for local/standalone mode.
 *
 * Uses the generator's output/<projectId>/ scratch directory for all I/O.
 * Inputs are written under output/<projectId>/edit-io/<editJobId>/inputs/.
 * Outputs are read from output/<projectId>/edit-io/<editJobId>/outputs/.
 *
 * signedGetUrl is unsupported in local mode (returns undefined).
 *
 * Requirements: 10
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import type { StorageAdapter } from "./storageAdapter";
import { deriveKey } from "./storageAdapter";

export class LocalStorageAdapter implements StorageAdapter {
  private readonly baseDir: string;

  /**
   * @param projectId  The project whose output dir is used as the base.
   *                   If omitted, uses a default "edit-local" sub within outputDir.
   * @param overrideBaseDir  If provided, overrides the computed baseDir
   *                         (useful for testing without relying on config module).
   */
  constructor(projectId?: string, overrideBaseDir?: string) {
    if (overrideBaseDir) {
      this.baseDir = overrideBaseDir;
    } else {
      this.baseDir = projectId
        ? path.join(config.storage.outputDir, projectId)
        : path.join(config.storage.outputDir, "edit-local");
    }
  }

  private resolveKey(key: string): string {
    return path.join(this.baseDir, ...key.split("/"));
  }

  async putInput(
    editJobId: string,
    relKey: string,
    data: Uint8Array
  ): Promise<string> {
    const key = deriveKey(editJobId, "inputs", relKey);
    const abs = this.resolveKey(key);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, data);
    return key;
  }

  async getOutputStream(
    editJobId: string,
    relKey: string,
    range?: { start: number; end?: number }
  ): Promise<Uint8Array> {
    const key = deriveKey(editJobId, "outputs", relKey);
    const abs = this.resolveKey(key);
    const buf = await fsp.readFile(abs);
    if (range) {
      const end = range.end !== undefined ? range.end + 1 : buf.length;
      return new Uint8Array(buf.buffer, buf.byteOffset + range.start, end - range.start);
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  /**
   * In local mode, "persisting" means the file is already on disk in the outputs area.
   * We just return the key (the path relative to baseDir) as the output reference.
   */
  async persistOutput(
    editJobId: string,
    relKey: string
  ): Promise<string | undefined> {
    const key = deriveKey(editJobId, "outputs", relKey);
    const abs = this.resolveKey(key);
    try {
      await fsp.access(abs);
      return key;
    } catch {
      return undefined;
    }
  }

  /**
   * Signed URLs are not supported in local mode.
   */
  async signedGetUrl(
    _outputKey: string,
    _ttlSec: number
  ): Promise<string | undefined> {
    return undefined;
  }
}
