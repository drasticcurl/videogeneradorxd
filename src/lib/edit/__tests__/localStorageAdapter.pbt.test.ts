/**
 * Property-based test: Standalone round-trip invariance (LocalStorageAdapter).
 *
 * Property 4: For any input byte buffer, putInput then read-back returns a
 * byte-for-byte identical buffer.
 *
 * **Validates: Requirements 10.4**
 *
 * Uses fast-check.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LocalStorageAdapter } from "../localStorageAdapter";

// ---------------------------------------------------------------------------
// Test setup: use a temp directory as the adapter base.
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "edit-pbt-local-"));
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Smart generators
// ---------------------------------------------------------------------------

/** Generate a valid editJobId (alphanumeric, non-empty, no path traversal). */
const editJobIdArb = fc.stringMatching(/^[a-z0-9]{4,20}$/);

/** Generate a valid relative key (simple filename, no traversal). */
const relKeyArb = fc
  .stringMatching(/^[a-z0-9_]{1,20}\.[a-z]{2,4}$/)
  .filter((s) => !s.includes("..") && !s.startsWith("/"));

/** Generate arbitrary byte buffers (including empty). */
const bytesArb = fc.uint8Array({ minLength: 0, maxLength: 4096 });

// ---------------------------------------------------------------------------
// Property test
// ---------------------------------------------------------------------------

describe("LocalStorageAdapter — Property: Standalone Round-Trip Invariance (P4)", () => {
  it("putInput then read-back from disk returns byte-for-byte identical buffer", async () => {
    await fc.assert(
      fc.asyncProperty(editJobIdArb, relKeyArb, bytesArb, async (editJobId, relKey, data) => {
        const adapter = new LocalStorageAdapter(undefined, tmpDir);

        // Write the input
        const key = await adapter.putInput(editJobId, relKey, data);
        expect(key).toContain(`edit-io/${editJobId}/inputs/`);

        // Read back directly from the filesystem to verify byte-for-byte round-trip
        const abs = path.join(tmpDir, ...key.split("/"));
        const readBack = await fsp.readFile(abs);

        expect(readBack.length).toBe(data.length);
        expect(Buffer.compare(readBack, Buffer.from(data))).toBe(0);
      }),
      { numRuns: 200 }
    );
  });

  it("putInput then reading from outputs dir also round-trips (simulate editor writing same bytes to outputs)", async () => {
    await fc.assert(
      fc.asyncProperty(editJobIdArb, relKeyArb, bytesArb, async (editJobId, relKey, data) => {
        const adapter = new LocalStorageAdapter(undefined, tmpDir);

        // Simulate: editor writes to outputs (same bytes)
        const outputKey = `edit-io/${editJobId}/outputs/${relKey}`;
        const abs = path.join(tmpDir, ...outputKey.split("/"));
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, data);

        // Read back via getOutputStream
        const readBack = await adapter.getOutputStream(editJobId, relKey);

        expect(readBack.length).toBe(data.length);
        expect(Buffer.compare(Buffer.from(readBack), Buffer.from(data))).toBe(0);
      }),
      { numRuns: 200 }
    );
  });
});
