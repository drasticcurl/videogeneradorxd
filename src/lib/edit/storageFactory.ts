import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "@/lib/config";
import { getEditMode } from "./config";
import { LocalStorageAdapter } from "./localStorageAdapter";
import type { StorageAdapter } from "./storageAdapter";
import {
  VolumeStorageAdapter,
  type DurableStorage,
} from "./volumeStorageAdapter";

const EDIT_OUTPUT_PREFIX = "edit-output";

/**
 * Durable storage backed by the existing OUTPUT_DIR filesystem. In Cloud Run
 * that directory is the existing GCS FUSE mount, so no second bucket or cloud
 * SDK is required.
 */
export class FilesystemDurableStorage implements DurableStorage {
  constructor(private readonly root: string = config.storage.outputDir) {}

  private safePath(key: string): string | undefined {
    if (!key || key.includes("\\") || path.isAbsolute(key)) return undefined;
    const normalized = path.posix.normalize(key);
    if (
      normalized === ".." ||
      normalized.startsWith("../") ||
      (normalized !== EDIT_OUTPUT_PREFIX &&
        !normalized.startsWith(`${EDIT_OUTPUT_PREFIX}/`))
    ) {
      return undefined;
    }

    const root = path.resolve(this.root);
    const resolved = path.resolve(root, ...normalized.split("/"));
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      return undefined;
    }
    return resolved;
  }

  async persist(localPath: string, outputKey: string): Promise<string> {
    const destination = this.safePath(outputKey);
    if (!destination) {
      throw new Error(`Invalid durable edit output key: ${outputKey}`);
    }
    await fsp.access(localPath);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.copyFile(localPath, destination);
    return path.posix.normalize(outputKey);
  }

  async resolve(key: string): Promise<string | undefined> {
    const resolved = this.safePath(key);
    if (!resolved) return undefined;
    try {
      await fsp.access(resolved);
      return resolved;
    } catch {
      return undefined;
    }
  }

  async signedUrl(
    _outputKey: string,
    _ttlSec: number
  ): Promise<string | undefined> {
    return undefined;
  }
}

export function createEditStorageAdapter(projectId: string): StorageAdapter {
  if (getEditMode() === "cloud") {
    return new VolumeStorageAdapter(new FilesystemDurableStorage());
  }
  return new LocalStorageAdapter(projectId);
}
