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
import { deriveKey, relativeInputKey } from "./storageAdapter";

async function readFileRange(
  filePath: string,
  range: { start: number; end?: number }
): Promise<Uint8Array> {
  const fd = await fsp.open(filePath, "r");
  try {
    const stat = await fd.stat();
    const endExclusive = range.end === undefined
      ? stat.size
      : Math.min(range.end + 1, stat.size);
    const length = Math.max(0, endExclusive - range.start);
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await fd.read(
        buffer,
        offset,
        length - offset,
        range.start + offset
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const result = buffer.subarray(0, offset);
    return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
  } finally {
    await fd.close();
  }
}

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

  async toEditorInputReference(
    editJobId: string,
    storedKey: string
  ): Promise<string> {
    relativeInputKey(editJobId, storedKey);
    const abs = path.resolve(this.resolveKey(storedKey));
    const root = path.resolve(this.baseDir);
    if (!abs.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Local editor input escaped storage root: ${storedKey}`);
    }
    await fsp.access(abs);
    return abs;
  }

  async getOutputStream(
    editJobId: string,
    relKey: string,
    range?: { start: number; end?: number }
  ): Promise<Uint8Array> {
    const key = deriveKey(editJobId, "outputs", relKey);
    const abs = this.resolveKey(key);
    if (range) {
      return readFileRange(abs, range);
    }
    const buf = await fsp.readFile(abs);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async getOutputSize(editJobId: string, relKey: string): Promise<number> {
    const key = deriveKey(editJobId, "outputs", relKey);
    return (await fsp.stat(this.resolveKey(key))).size;
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
