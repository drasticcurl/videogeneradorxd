/**
 * Unit tests for the b-roll bank: validation and listing.
 *
 * Covers:
 * - Unsupported format rejection (Req 3.4)
 * - Empty/oversized file rejection (Req 3.5)
 * - List entries include id + required metadata (Req 3.1, 3.2)
 * - Selection resolution (Req 3.3)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  BrollBank,
  SUPPORTED_BROLL_MIMES,
  SUPPORTED_BROLL_EXTENSIONS,
} from "../brollBank";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "broll-test-"));
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function makeBank(): BrollBank {
  return new BrollBank(tmpDir);
}

// ---------------------------------------------------------------------------
// Validation tests (sub-task 6.2)
// ---------------------------------------------------------------------------

describe("BrollBank.validateUpload", () => {
  it("accepts all supported MIME types", () => {
    const bank = makeBank();
    for (const mime of SUPPORTED_BROLL_MIMES) {
      const err = bank.validateUpload(mime, 1024);
      expect(err).toBeNull();
    }
  });

  it("rejects unsupported MIME types", () => {
    const bank = makeBank();
    const unsupported = [
      "image/png",
      "audio/mp3",
      "application/pdf",
      "video/x-flv",
      "text/plain",
    ];
    for (const mime of unsupported) {
      const err = bank.validateUpload(mime, 1024);
      expect(err).not.toBeNull();
      expect(err!.code).toBe("UNSUPPORTED_FORMAT");
      expect(err!.supportedFormats).toEqual(
        expect.arrayContaining(["mp4", "webm", "mov", "mkv", "avi"])
      );
    }
  });

  it("rejects 0-byte files", () => {
    const bank = makeBank();
    const err = bank.validateUpload("video/mp4", 0);
    expect(err).not.toBeNull();
    expect(err!.code).toBe("INVALID_SIZE");
    expect(err!.allowedRange).toBeDefined();
    expect(err!.allowedRange!.min).toBe(1);
  });

  it("rejects negative-size files", () => {
    const bank = makeBank();
    const err = bank.validateUpload("video/mp4", -100);
    expect(err).not.toBeNull();
    expect(err!.code).toBe("INVALID_SIZE");
  });

  it("rejects oversized files", () => {
    const bank = makeBank();
    const maxBytes = 500 * 1024 * 1024; // default MAX_BROLL_BYTES
    const err = bank.validateUpload("video/mp4", maxBytes + 1);
    expect(err).not.toBeNull();
    expect(err!.code).toBe("INVALID_SIZE");
    expect(err!.allowedRange).toBeDefined();
    expect(err!.allowedRange!.max).toBe(maxBytes);
  });

  it("accepts files at exactly the max size", () => {
    const bank = makeBank();
    const maxBytes = 500 * 1024 * 1024;
    const err = bank.validateUpload("video/mp4", maxBytes);
    expect(err).toBeNull();
  });

  it("accepts a 1-byte file (minimum valid size)", () => {
    const bank = makeBank();
    const err = bank.validateUpload("video/mp4", 1);
    expect(err).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Upload + List tests (sub-tasks 6.1, 6.2)
// ---------------------------------------------------------------------------

describe("BrollBank.upload", () => {
  it("returns error for unsupported format without storing anything", async () => {
    const bank = makeBank();
    const data = new Uint8Array(1024);
    const { result, error } = await bank.upload("test.flv", "video/x-flv", data);
    expect(result).toBeUndefined();
    expect(error).toBeDefined();
    expect(error!.code).toBe("UNSUPPORTED_FORMAT");

    // Nothing stored
    const list = await bank.list();
    expect(list).toHaveLength(0);
  });

  it("returns error for empty file without storing anything", async () => {
    const bank = makeBank();
    const data = new Uint8Array(0);
    const { result, error } = await bank.upload("test.mp4", "video/mp4", data);
    expect(result).toBeUndefined();
    expect(error).toBeDefined();
    expect(error!.code).toBe("INVALID_SIZE");

    const list = await bank.list();
    expect(list).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// List metadata tests (sub-task 6.1)
// ---------------------------------------------------------------------------

describe("BrollBank.list", () => {
  it("returns empty array when no clips uploaded", async () => {
    const bank = makeBank();
    const list = await bank.list();
    expect(list).toEqual([]);
  });

  it("list entries include id, name, durationSec, and uploadedAt", async () => {
    const bank = makeBank();

    // Manually write a metadata file to test listing without needing ffprobe
    const metaPath = path.join(tmpDir, "broll", "broll_meta.json");
    await fsp.mkdir(path.join(tmpDir, "broll"), { recursive: true });
    const meta = [
      {
        id: "test-id-001",
        name: "clip1.mp4",
        durationSec: 5.5,
        uploadedAt: "2024-01-01T00:00:00.000Z",
      },
      {
        id: "test-id-002",
        name: "intro.mov",
        durationSec: 12.3,
        uploadedAt: "2024-01-02T00:00:00.000Z",
      },
    ];
    await fsp.writeFile(metaPath, JSON.stringify(meta), "utf8");

    const list = await bank.list();
    expect(list).toHaveLength(2);

    // Verify each entry has the required fields
    for (const entry of list) {
      expect(entry).toHaveProperty("id");
      expect(typeof entry.id).toBe("string");
      expect(entry.id.length).toBeGreaterThan(0);

      expect(entry).toHaveProperty("name");
      expect(typeof entry.name).toBe("string");

      expect(entry).toHaveProperty("durationSec");
      expect(typeof entry.durationSec).toBe("number");
      expect(entry.durationSec).toBeGreaterThan(0);

      expect(entry).toHaveProperty("uploadedAt");
      expect(typeof entry.uploadedAt).toBe("string");
      // Should be a valid ISO date
      expect(new Date(entry.uploadedAt).toISOString()).toBe(entry.uploadedAt);
    }
  });
});

// ---------------------------------------------------------------------------
// Selection / Resolution tests (sub-task 6.1)
// ---------------------------------------------------------------------------

describe("BrollBank.resolve", () => {
  it("returns error for empty selection", async () => {
    const bank = makeBank();
    const { paths, error } = await bank.resolve([]);
    expect(paths).toBeUndefined();
    expect(error).toMatch(/between 1 and/);
  });

  it("returns error for non-existent clip IDs", async () => {
    const bank = makeBank();
    const { paths, error } = await bank.resolve(["nonexistent-id"]);
    expect(paths).toBeUndefined();
    expect(error).toMatch(/not found/i);
    expect(error).toContain("nonexistent-id");
  });

  it("resolves existing clips to their paths", async () => {
    const bank = makeBank();

    // Create broll dir and metadata + files
    const brollDir = path.join(tmpDir, "broll");
    await fsp.mkdir(brollDir, { recursive: true });

    const id1 = "resolve-test-001";
    const id2 = "resolve-test-002";

    // Write clip files
    await fsp.writeFile(path.join(brollDir, `${id1}.mp4`), "fake-video-1");
    await fsp.writeFile(path.join(brollDir, `${id2}.webm`), "fake-video-2");

    // Write metadata
    const meta = [
      { id: id1, name: "clip1.mp4", durationSec: 5, uploadedAt: "2024-01-01T00:00:00.000Z" },
      { id: id2, name: "clip2.webm", durationSec: 8, uploadedAt: "2024-01-02T00:00:00.000Z" },
    ];
    await fsp.writeFile(path.join(brollDir, "broll_meta.json"), JSON.stringify(meta), "utf8");

    const { paths, error } = await bank.resolve([id1, id2]);
    expect(error).toBeUndefined();
    expect(paths).toHaveLength(2);
    expect(paths![0]).toContain(id1);
    expect(paths![1]).toContain(id2);
  });
});

// ---------------------------------------------------------------------------
// SUPPORTED_BROLL_MIMES constant coverage
// ---------------------------------------------------------------------------

describe("SUPPORTED_BROLL_MIMES", () => {
  it("includes the 5 required formats", () => {
    expect(SUPPORTED_BROLL_MIMES.has("video/mp4")).toBe(true);
    expect(SUPPORTED_BROLL_MIMES.has("video/webm")).toBe(true);
    expect(SUPPORTED_BROLL_MIMES.has("video/quicktime")).toBe(true);
    expect(SUPPORTED_BROLL_MIMES.has("video/x-matroska")).toBe(true);
    expect(SUPPORTED_BROLL_MIMES.has("video/x-msvideo")).toBe(true);
  });
});

describe("SUPPORTED_BROLL_EXTENSIONS", () => {
  it("includes mp4, webm, mov, mkv, avi", () => {
    expect(SUPPORTED_BROLL_EXTENSIONS).toContain("mp4");
    expect(SUPPORTED_BROLL_EXTENSIONS).toContain("webm");
    expect(SUPPORTED_BROLL_EXTENSIONS).toContain("mov");
    expect(SUPPORTED_BROLL_EXTENSIONS).toContain("mkv");
    expect(SUPPORTED_BROLL_EXTENSIONS).toContain("avi");
  });
});
