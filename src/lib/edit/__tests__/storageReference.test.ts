import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalStorageAdapter } from "../localStorageAdapter";
import { VolumeStorageAdapter, type DurableStorage } from "../volumeStorageAdapter";
import { KeyConfinementError } from "../storageAdapter";

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "edit-reference-"));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe("editor input reference contract", () => {
  it("returns a confined flat relative filename in cloud mode", async () => {
    const durable: DurableStorage = {
      persist: vi.fn(),
      signedUrl: vi.fn(),
      resolve: vi.fn(),
    };
    const adapter = new VolumeStorageAdapter(durable, root);
    const storedKey = await adapter.putInput("edit-1", "clip-0001.mp4", new Uint8Array([1]));

    await expect(adapter.toEditorInputReference("edit-1", storedKey))
      .resolves.toBe("clip-0001.mp4");
    await expect(adapter.toEditorInputReference("edit-1", "edit-io/other/inputs/clip.mp4"))
      .rejects.toThrow(KeyConfinementError);
    await expect(adapter.toEditorInputReference("edit-1", "edit-io/edit-1/inputs/nested/clip.mp4"))
      .rejects.toThrow("flat filenames");
  });

  it("returns the actual confined input path in local mode", async () => {
    const adapter = new LocalStorageAdapter(undefined, root);
    const storedKey = await adapter.putInput("edit-1", "clip-0001.mp4", new Uint8Array([1]));
    const reference = await adapter.toEditorInputReference("edit-1", storedKey);

    expect(path.isAbsolute(reference)).toBe(true);
    expect(reference).toBe(path.join(root, "edit-io", "edit-1", "inputs", "clip-0001.mp4"));
    await expect(adapter.toEditorInputReference("edit-1", "edit-io/edit-2/inputs/clip.mp4"))
      .rejects.toThrow(KeyConfinementError);
  });
});
