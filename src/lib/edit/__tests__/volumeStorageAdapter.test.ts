/**
 * Unit tests for VolumeStorageAdapter with the existing-storage module mocked.
 *
 * Asserts:
 * - Inputs written under Shared_Volume inputs/ prefix.
 * - Outputs read from outputs/ prefix.
 * - Prefix scoping enforced (traversal rejected).
 * - Durable persist delegates to existing storage.
 *
 * Requirements: 6, 7, 9
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { VolumeStorageAdapter } from "../volumeStorageAdapter";
import type { DurableStorage } from "../volumeStorageAdapter";
import { KeyConfinementError } from "../storageAdapter";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let mockDurableStorage: DurableStorage;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "edit-vol-test-"));
  mockDurableStorage = {
    persist: vi.fn().mockImplementation(async (_localPath: string, outputKey: string) => outputKey),
    signedUrl: vi.fn().mockImplementation(async (key: string, _ttl: number) => `https://storage.example.com/${key}?signed=true`),
    resolve: vi.fn().mockImplementation(async (_key: string) => undefined),
  };
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function createAdapter(): VolumeStorageAdapter {
  return new VolumeStorageAdapter(mockDurableStorage, tmpDir);
}

// ---------------------------------------------------------------------------
// Tests: Input writing
// ---------------------------------------------------------------------------

describe("VolumeStorageAdapter — putInput", () => {
  it("writes input under Shared_Volume edit-io/<editJobId>/inputs/ prefix", async () => {
    const adapter = createAdapter();
    const data = new Uint8Array([1, 2, 3, 4, 5]);

    const key = await adapter.putInput("job-001", "clip_01.mp4", data);

    expect(key).toBe("edit-io/job-001/inputs/clip_01.mp4");
    const abs = path.join(tmpDir, "edit-io", "job-001", "inputs", "clip_01.mp4");
    const readBack = await fsp.readFile(abs);
    expect(Buffer.compare(readBack, Buffer.from(data))).toBe(0);
  });

  it("supports nested relKeys (subdirectories within inputs)", async () => {
    const adapter = createAdapter();
    const data = new Uint8Array([10, 20, 30]);

    const key = await adapter.putInput("job-002", "subdir/clip.mp4", data);

    expect(key).toBe("edit-io/job-002/inputs/subdir/clip.mp4");
    const abs = path.join(tmpDir, "edit-io", "job-002", "inputs", "subdir", "clip.mp4");
    const readBack = await fsp.readFile(abs);
    expect(Buffer.compare(readBack, Buffer.from(data))).toBe(0);
  });

  it("rejects traversal in relKey", async () => {
    const adapter = createAdapter();
    const data = new Uint8Array([1]);

    await expect(
      adapter.putInput("job-003", "../../../etc/passwd", data)
    ).rejects.toThrow(KeyConfinementError);
  });

  it("rejects absolute path in relKey", async () => {
    const adapter = createAdapter();
    const data = new Uint8Array([1]);

    await expect(
      adapter.putInput("job-004", "/etc/passwd", data)
    ).rejects.toThrow(KeyConfinementError);
  });

  it("rejects empty relKey", async () => {
    const adapter = createAdapter();
    const data = new Uint8Array([1]);

    await expect(
      adapter.putInput("job-005", "", data)
    ).rejects.toThrow(KeyConfinementError);
  });
});

// ---------------------------------------------------------------------------
// Tests: Output reading
// ---------------------------------------------------------------------------

describe("VolumeStorageAdapter — getOutputStream", () => {
  it("reads output from edit-io/<editJobId>/outputs/ prefix", async () => {
    const adapter = createAdapter();
    const data = Buffer.from("fake video content");

    // Write directly to the outputs location on the "volume"
    const outputDir = path.join(tmpDir, "edit-io", "job-010", "outputs");
    await fsp.mkdir(outputDir, { recursive: true });
    await fsp.writeFile(path.join(outputDir, "final.mp4"), data);

    const result = await adapter.getOutputStream("job-010", "final.mp4");

    expect(Buffer.compare(Buffer.from(result), data)).toBe(0);
  });

  it("supports Range-aware reads", async () => {
    const adapter = createAdapter();
    const data = Buffer.from("0123456789ABCDEF");

    const outputDir = path.join(tmpDir, "edit-io", "job-011", "outputs");
    await fsp.mkdir(outputDir, { recursive: true });
    await fsp.writeFile(path.join(outputDir, "video.mp4"), data);

    const slice = await adapter.getOutputStream("job-011", "video.mp4", {
      start: 4,
      end: 9,
    });

    expect(Buffer.from(slice).toString()).toBe("456789");
  });

  it("reads only the requested range from durable fallback", async () => {
    const adapter = createAdapter();
    const durableFile = path.join(tmpDir, "durable-video.mp4");
    await fsp.writeFile(durableFile, Buffer.from("0123456789ABCDEF"));
    (mockDurableStorage.resolve as ReturnType<typeof vi.fn>).mockResolvedValue(durableFile);

    const slice = await adapter.getOutputStream("job-011", "final.mp4", {
      start: 5,
      end: 8,
    });

    expect(Buffer.from(slice).toString()).toBe("5678");
    await expect(adapter.getOutputSize("job-011", "final.mp4")).resolves.toBe(16);
  });

  it("rejects traversal in output relKey", async () => {
    const adapter = createAdapter();

    await expect(
      adapter.getOutputStream("job-012", "../../secret.txt")
    ).rejects.toThrow(KeyConfinementError);
  });
});

// ---------------------------------------------------------------------------
// Tests: Durable persistence delegation
// ---------------------------------------------------------------------------

describe("VolumeStorageAdapter — persistOutput", () => {
  it("delegates to durable storage with correct output key", async () => {
    const adapter = createAdapter();
    const data = Buffer.from("finished video");

    // Place file in outputs area on the volume
    const outputDir = path.join(tmpDir, "edit-io", "job-020", "outputs");
    await fsp.mkdir(outputDir, { recursive: true });
    await fsp.writeFile(path.join(outputDir, "final.mp4"), data);

    const result = await adapter.persistOutput("job-020", "final.mp4");

    expect(result).toBe("edit-output/job-020/final.mp4");
    expect(mockDurableStorage.persist).toHaveBeenCalledWith(
      path.join(tmpDir, "edit-io", "job-020", "outputs", "final.mp4"),
      "edit-output/job-020/final.mp4"
    );
  });

  it("returns an already durable key without requiring shared scratch or copying again", async () => {
    const adapter = createAdapter();
    const durableFile = path.join(tmpDir, "durable-final.mp4");
    await fsp.writeFile(durableFile, Buffer.from("durable"));
    (mockDurableStorage.resolve as ReturnType<typeof vi.fn>).mockResolvedValueOnce(durableFile);

    const result = await adapter.persistOutput("job-021", "final.mp4");

    expect(result).toBe("edit-output/job-021/final.mp4");
    expect(mockDurableStorage.persist).not.toHaveBeenCalled();
  });

  it("returns undefined when output file does not exist", async () => {
    const adapter = createAdapter();

    const result = await adapter.persistOutput("job-021", "nonexistent.mp4");

    expect(result).toBeUndefined();
    expect(mockDurableStorage.persist).not.toHaveBeenCalled();
  });

  it("returns undefined when durable storage persist fails", async () => {
    const adapter = createAdapter();
    (mockDurableStorage.persist as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("GCS upload failed")
    );

    // Place file in outputs area
    const outputDir = path.join(tmpDir, "edit-io", "job-022", "outputs");
    await fsp.mkdir(outputDir, { recursive: true });
    await fsp.writeFile(path.join(outputDir, "result.mp4"), Buffer.from("data"));

    const result = await adapter.persistOutput("job-022", "result.mp4");

    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: Signed URL delegation
// ---------------------------------------------------------------------------

describe("VolumeStorageAdapter — signedGetUrl", () => {
  it("delegates to durable storage signedUrl method", async () => {
    const adapter = createAdapter();

    const url = await adapter.signedGetUrl("edit-output/job-030/final.mp4", 3600);

    expect(url).toBe(
      "https://storage.example.com/edit-output/job-030/final.mp4?signed=true"
    );
    expect(mockDurableStorage.signedUrl).toHaveBeenCalledWith(
      "edit-output/job-030/final.mp4",
      3600
    );
  });

  it("returns undefined when durable storage does not support signed URLs", async () => {
    (mockDurableStorage.signedUrl as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      undefined
    );
    const adapter = createAdapter();

    const url = await adapter.signedGetUrl("some-key", 3600);

    expect(url).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: Materialize from existing storage
// ---------------------------------------------------------------------------

describe("VolumeStorageAdapter — materializeFromExisting", () => {
  it("copies source from existing storage to volume inputs/", async () => {
    const adapter = createAdapter();

    // Set up a "source" file that existing storage resolves to
    const sourceFile = path.join(tmpDir, "_existing_source.mp4");
    await fsp.writeFile(sourceFile, Buffer.from("source video data"));
    (mockDurableStorage.resolve as ReturnType<typeof vi.fn>).mockResolvedValueOnce(sourceFile);

    const key = await adapter.materializeFromExisting(
      "job-040",
      "clips/01_intro.mp4",
      "clip_01.mp4"
    );

    expect(key).toBe("edit-io/job-040/inputs/clip_01.mp4");
    const abs = path.join(tmpDir, "edit-io", "job-040", "inputs", "clip_01.mp4");
    const readBack = await fsp.readFile(abs);
    expect(readBack.toString()).toBe("source video data");
  });

  it("is a no-op if the file is already materialized", async () => {
    const adapter = createAdapter();

    // Pre-place the file
    const targetDir = path.join(tmpDir, "edit-io", "job-041", "inputs");
    await fsp.mkdir(targetDir, { recursive: true });
    await fsp.writeFile(path.join(targetDir, "clip.mp4"), Buffer.from("already here"));

    const key = await adapter.materializeFromExisting(
      "job-041",
      "clips/whatever.mp4",
      "clip.mp4"
    );

    expect(key).toBe("edit-io/job-041/inputs/clip.mp4");
    // Should NOT have called resolve (no-op)
    expect(mockDurableStorage.resolve).not.toHaveBeenCalled();
  });

  it("throws when source artifact not found in existing storage", async () => {
    const adapter = createAdapter();
    (mockDurableStorage.resolve as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

    await expect(
      adapter.materializeFromExisting("job-042", "missing/file.mp4", "clip.mp4")
    ).rejects.toThrow("not found in existing storage");
  });
});
