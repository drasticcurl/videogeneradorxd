import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalStorageAdapter } from "../localStorageAdapter";
import { VolumeStorageAdapter } from "../volumeStorageAdapter";
import {
  FilesystemDurableStorage,
  createEditStorageAdapter,
} from "../storageFactory";

const originalMode = process.env.EDIT_MODE;

afterEach(() => {
  if (originalMode === undefined) delete process.env.EDIT_MODE;
  else process.env.EDIT_MODE = originalMode;
});

describe("createEditStorageAdapter", () => {
  it("selects local storage in local mode", () => {
    process.env.EDIT_MODE = "local";
    expect(createEditStorageAdapter("project-1")).toBeInstanceOf(LocalStorageAdapter);
  });

  it("selects volume storage in cloud mode", () => {
    process.env.EDIT_MODE = "cloud";
    expect(createEditStorageAdapter("project-1")).toBeInstanceOf(VolumeStorageAdapter);
  });
});

describe("FilesystemDurableStorage", () => {
  it("persists and resolves files under edit-output only", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "durable-edit-"));
    try {
      const source = path.join(root, "source.mp4");
      await fsp.writeFile(source, "video");
      const storage = new FilesystemDurableStorage(root);
      const key = await storage.persist(source, "edit-output/job-1/final.mp4");
      expect(key).toBe("edit-output/job-1/final.mp4");
      expect(await storage.resolve(key)).toBe(
        path.join(root, "edit-output", "job-1", "final.mp4")
      );
      expect(await storage.signedUrl(key, 300)).toBeUndefined();
      await expect(storage.persist(source, "../secret.mp4")).rejects.toThrow();
      expect(await storage.resolve("other-prefix/file.mp4")).toBeUndefined();
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
