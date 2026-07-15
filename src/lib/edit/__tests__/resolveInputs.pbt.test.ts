/**
 * Property-based tests for source resolution and ordering.
 *
 * Property 1: Order preservation — for any set of generated clips + b-roll and
 * any valid ordering O, the orden_clips produced equals O (same sequence).
 *
 * **Validates: Requirements 1.7, 4.1, 4.2**
 *
 * Uses fast-check.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { mergeOrdering, type ResolvedInput } from "../resolveInputs";
import { BrollBank } from "../brollBank";
import type { ClipOrderEntry } from "../types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "resolve-pbt-"));
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

/**
 * Creates a BrollBank with pre-seeded b-roll clips on disk.
 */
async function seedBrollBank(
  brollIds: string[]
): Promise<BrollBank> {
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

  // Create actual clip files on disk
  for (const id of brollIds) {
    await fsp.writeFile(path.join(brollDir, `${id}.mp4`), "fake-broll-video");
  }

  return bank;
}

/**
 * Creates fake generated input entries pointing to real files.
 */
async function createGeneratedInputs(
  genIds: string[]
): Promise<ResolvedInput[]> {
  const genDir = path.join(tmpDir, "gen");
  await fsp.mkdir(genDir, { recursive: true });

  const inputs: ResolvedInput[] = [];
  for (const id of genIds) {
    const filePath = path.join(genDir, `${id}.mp4`);
    await fsp.writeFile(filePath, "fake-gen-video");
    inputs.push({ id, absPath: filePath, isBroll: false });
  }
  return inputs;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Generates a scenario with N generated clips and M b-roll clips,
 * and a valid ordering that interleaves them.
 */
function validOrderingScenario() {
  return fc
    .record({
      numGen: fc.integer({ min: 1, max: 20 }),
      numBroll: fc.integer({ min: 0, max: 10 }),
    })
    .chain(({ numGen, numBroll }) => {
      const total = numGen + numBroll;
      // Generate unique IDs for generated and broll clips
      const genIds = Array.from({ length: numGen }, (_, i) => `gen-${i}`);
      const brollIds = Array.from({ length: numBroll }, (_, i) => `broll-${i}`);

      // Generate a random permutation of indexes 0..total-1 assigning
      // each entry to either a gen or broll clip
      return fc
        .shuffledSubarray(
          Array.from({ length: total }, (_, i) => i),
          { minLength: total, maxLength: total }
        )
        .map((shuffledIndexes) => {
          // First numGen entries get generated IDs, rest get broll IDs
          const ordering: ClipOrderEntry[] = [];
          for (let i = 0; i < numGen; i++) {
            ordering.push({
              index: shuffledIndexes[i],
              clipId: genIds[i],
              isBroll: false,
            });
          }
          for (let i = 0; i < numBroll; i++) {
            ordering.push({
              index: shuffledIndexes[numGen + i],
              clipId: brollIds[i],
              isBroll: true,
            });
          }
          return { genIds, brollIds, ordering, total };
        });
    });
}

// ---------------------------------------------------------------------------
// Property 1: Order preservation
// ---------------------------------------------------------------------------

describe("resolveInputs PBT", () => {
  it("P1: orden_clips preserves the exact order specified by the user ordering", async () => {
    await fc.assert(
      fc.asyncProperty(validOrderingScenario(), async ({ genIds, brollIds, ordering }) => {
        // Setup: create the generated inputs and seed the broll bank
        const generatedInputs = await createGeneratedInputs(genIds);
        const bank = await seedBrollBank(brollIds);

        // Execute: merge the ordering
        const result = await mergeOrdering(generatedInputs, ordering, bank);

        // Assert: no error
        expect(result.error).toBeUndefined();
        expect(result.ordenClips).toBeDefined();

        // The output should have exactly as many entries as the ordering
        expect(result.ordenClips!.length).toBe(ordering.length);

        // Sort the input ordering by index to get the expected sequence
        const expectedSequence = [...ordering].sort((a, b) => a.index - b.index);

        // Verify each position matches exactly
        for (let i = 0; i < expectedSequence.length; i++) {
          const expected = expectedSequence[i];
          const actual = result.ordenClips![i];

          // The clip at position i should have the correct id and isBroll flag
          expect(actual.id).toBe(expected.clipId);
          expect(actual.isBroll).toBe(expected.isBroll);
        }
      }),
      { numRuns: 100 }
    );
  });
});
