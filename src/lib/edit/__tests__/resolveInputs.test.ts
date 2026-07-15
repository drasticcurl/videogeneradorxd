/**
 * Unit tests for source resolution and b-roll ordering edge cases.
 *
 * Covers:
 * - Missing artifact (Req 1.5)
 * - Count < 1 (Req 1.6)
 * - Count > 500 (Req 1.6)
 * - Out-of-range / non-contiguous b-roll index (Req 4.4, 4.5)
 * - Missing b-roll id (Req 3.6)
 *
 * Requirements: 1.5, 1.6, 3.6, 4.3, 4.4, 4.5
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  resolveSource,
  mergeOrdering,
  buildDefaultOrdering,
  type ResolvedInput,
} from "../resolveInputs";
import { BrollBank } from "../brollBank";
import type { ClipOrderEntry, EditSource } from "../types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let projectTmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "resolve-test-"));
  projectTmpDir = path.join(tmpDir, "project-output");
  await fsp.mkdir(projectTmpDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

/**
 * Helper: create a BrollBank seeded with specific clip IDs.
 */
async function seedBrollBank(brollIds: string[]): Promise<BrollBank> {
  const bank = new BrollBank(tmpDir);
  const brollDir = path.join(tmpDir, "broll");
  await fsp.mkdir(brollDir, { recursive: true });

  const meta = brollIds.map((id) => ({
    id,
    name: `${id}.mp4`,
    durationSec: 5.0,
    uploadedAt: new Date().toISOString(),
  }));
  await fsp.writeFile(
    path.join(brollDir, "broll_meta.json"),
    JSON.stringify(meta),
    "utf8"
  );

  for (const id of brollIds) {
    await fsp.writeFile(path.join(brollDir, `${id}.mp4`), "fake-broll");
  }

  return bank;
}

/**
 * Helper: create fake generated input entries.
 */
async function createGeneratedInputs(ids: string[]): Promise<ResolvedInput[]> {
  const genDir = path.join(tmpDir, "gen-clips");
  await fsp.mkdir(genDir, { recursive: true });

  const inputs: ResolvedInput[] = [];
  for (const id of ids) {
    const filePath = path.join(genDir, `${id}.mp4`);
    await fsp.writeFile(filePath, "fake-gen-video");
    inputs.push({ id, absPath: filePath, isBroll: false });
  }
  return inputs;
}

// ---------------------------------------------------------------------------
// resolveSource tests (sub-task 7.1)
// ---------------------------------------------------------------------------

describe("resolveSource", () => {
  it("returns error when final.mp4 artifact is missing (Req 1.5)", () => {
    // Use a non-existent project directory path
    // We need to mock the projectDir, but let's test the logic by pointing to our tmpDir
    // Instead, we'll directly test with the function by mocking the import
    // Since resolveSource uses projectDir from storage.ts which depends on config,
    // let's test the behavior through the mergeOrdering function and unit test resolveSource's logic separately
    
    // For this test, we verify the error message format for missing artifact
    const fakeProjectId = "nonexistent-project-id-12345";
    const source: EditSource = { type: "final", artifactKey: "final.mp4" };
    
    const result = resolveSource(fakeProjectId, source);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("Missing artifact");
    expect(result.error).toContain("final.mp4");
    expect(result.inputs).toBeUndefined();
  });

  it("returns error when clip source has zero clips (count < 1) (Req 1.6)", () => {
    const source: EditSource = { type: "clips", clipIds: [] };
    const result = resolveSource("any-project", source);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("between 1 and 500");
    expect(result.inputs).toBeUndefined();
  });

  it("returns error when clip source exceeds MAX_CLIPS_PER_JOB (>500) (Req 1.6)", () => {
    const tooManyClips = Array.from({ length: 501 }, (_, i) => `clip-${i}`);
    const source: EditSource = { type: "clips", clipIds: tooManyClips };
    const result = resolveSource("any-project", source);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("between 1 and 500");
    expect(result.error).toContain("501");
    expect(result.inputs).toBeUndefined();
  });

  it("returns error when a clip ID does not exist in the project (Req 1.5)", () => {
    const source: EditSource = { type: "clips", clipIds: ["nonexistent-clip"] };
    const result = resolveSource("nonexistent-project-xyz", source);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("Missing artifact");
    expect(result.error).toContain("nonexistent-clip");
    expect(result.inputs).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mergeOrdering tests (sub-task 7.2)
// ---------------------------------------------------------------------------

describe("mergeOrdering", () => {
  it("returns error when combined count < 1 (Req 4.3)", async () => {
    const bank = await seedBrollBank([]);
    const result = await mergeOrdering([], [], bank);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("between 1 and 500");
    expect(result.ordenClips).toBeUndefined();
  });

  it("returns error when combined count > MAX_CLIPS_PER_JOB (Req 4.3)", async () => {
    const bank = await seedBrollBank([]);
    const inputs = await createGeneratedInputs(["a"]);
    const tooManyOrdering: ClipOrderEntry[] = Array.from(
      { length: 501 },
      (_, i) => ({
        index: i,
        clipId: `clip-${i}`,
        isBroll: false,
      })
    );
    const result = await mergeOrdering(inputs, tooManyOrdering, bank);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("500");
    expect(result.ordenClips).toBeUndefined();
  });

  it("returns error when b-roll index is out of range (non-contiguous) (Req 4.4)", async () => {
    const genInputs = await createGeneratedInputs(["gen-1"]);
    const bank = await seedBrollBank(["broll-1"]);

    // Ordering with a gap: index 0, 2 (missing 1)
    const ordering: ClipOrderEntry[] = [
      { index: 0, clipId: "gen-1", isBroll: false },
      { index: 2, clipId: "broll-1", isBroll: true },
    ];

    const result = await mergeOrdering(genInputs, ordering, bank);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("contiguous");
    expect(result.ordenClips).toBeUndefined();
  });

  it("returns error when indexes are not unique (Req 4.5)", async () => {
    const genInputs = await createGeneratedInputs(["gen-1", "gen-2"]);
    const bank = await seedBrollBank([]);

    // Duplicate index 0
    const ordering: ClipOrderEntry[] = [
      { index: 0, clipId: "gen-1", isBroll: false },
      { index: 0, clipId: "gen-2", isBroll: false },
    ];

    const result = await mergeOrdering(genInputs, ordering, bank);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("unique");
    expect(result.ordenClips).toBeUndefined();
  });

  it("returns error when b-roll ID does not exist in bank (Req 3.6)", async () => {
    const genInputs = await createGeneratedInputs(["gen-1"]);
    const bank = await seedBrollBank([]); // empty bank

    const ordering: ClipOrderEntry[] = [
      { index: 0, clipId: "gen-1", isBroll: false },
      { index: 1, clipId: "nonexistent-broll", isBroll: true },
    ];

    const result = await mergeOrdering(genInputs, ordering, bank);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("nonexistent-broll");
    expect(result.error).toContain("not found");
    expect(result.ordenClips).toBeUndefined();
  });

  it("successfully merges generated clips and b-roll in specified order", async () => {
    const genInputs = await createGeneratedInputs(["gen-1", "gen-2"]);
    const bank = await seedBrollBank(["broll-1"]);

    // b-roll at index 1, between the two generated clips
    const ordering: ClipOrderEntry[] = [
      { index: 0, clipId: "gen-1", isBroll: false },
      { index: 1, clipId: "broll-1", isBroll: true },
      { index: 2, clipId: "gen-2", isBroll: false },
    ];

    const result = await mergeOrdering(genInputs, ordering, bank);
    expect(result.error).toBeUndefined();
    expect(result.ordenClips).toHaveLength(3);

    expect(result.ordenClips![0].id).toBe("gen-1");
    expect(result.ordenClips![0].isBroll).toBe(false);

    expect(result.ordenClips![1].id).toBe("broll-1");
    expect(result.ordenClips![1].isBroll).toBe(true);

    expect(result.ordenClips![2].id).toBe("gen-2");
    expect(result.ordenClips![2].isBroll).toBe(false);
  });

  it("places no inputs when validation fails (Req 4.3, 4.4, 4.5)", async () => {
    const genInputs = await createGeneratedInputs(["gen-1"]);
    const bank = await seedBrollBank(["broll-1"]);

    // Invalid: non-contiguous indexes
    const ordering: ClipOrderEntry[] = [
      { index: 0, clipId: "gen-1", isBroll: false },
      { index: 5, clipId: "broll-1", isBroll: true }, // gap
    ];

    const result = await mergeOrdering(genInputs, ordering, bank);
    expect(result.error).toBeDefined();
    expect(result.ordenClips).toBeUndefined(); // no inputs placed
  });

  it("returns error when generated clip in ordering doesn't match resolved inputs", async () => {
    const genInputs = await createGeneratedInputs(["gen-1"]);
    const bank = await seedBrollBank([]);

    // Ordering references a generated clip that wasn't resolved
    const ordering: ClipOrderEntry[] = [
      { index: 0, clipId: "gen-1", isBroll: false },
      { index: 1, clipId: "gen-unknown", isBroll: false },
    ];

    const result = await mergeOrdering(genInputs, ordering, bank);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("gen-unknown");
    expect(result.ordenClips).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildDefaultOrdering tests
// ---------------------------------------------------------------------------

describe("buildDefaultOrdering", () => {
  it("assigns sequential indexes starting from 0", async () => {
    const inputs = await createGeneratedInputs(["a", "b", "c"]);
    const ordering = buildDefaultOrdering(inputs);

    expect(ordering).toHaveLength(3);
    expect(ordering[0]).toEqual({ index: 0, clipId: "a", isBroll: false });
    expect(ordering[1]).toEqual({ index: 1, clipId: "b", isBroll: false });
    expect(ordering[2]).toEqual({ index: 2, clipId: "c", isBroll: false });
  });

  it("returns empty array for empty inputs", () => {
    const ordering = buildDefaultOrdering([]);
    expect(ordering).toEqual([]);
  });
});
