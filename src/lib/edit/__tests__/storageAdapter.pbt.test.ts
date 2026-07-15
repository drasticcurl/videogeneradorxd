/**
 * Property-based test: Least-privilege key confinement.
 *
 * Property 6: For any generated editJobId and any relKey, deriveKey either
 * returns a key strictly under edit-io/<editJobId>/ or rejects; no derived
 * key escapes the permitted prefixes.
 *
 * **Validates: Requirements 9.5, 9.6, 9.7**
 *
 * Uses fast-check.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { deriveKey, KeyConfinementError } from "../storageAdapter";

// ---------------------------------------------------------------------------
// Smart generators
// ---------------------------------------------------------------------------

/** Valid editJobId: alphanumeric, non-empty. */
const validEditJobIdArb = fc.stringMatching(/^[a-z0-9]{4,30}$/);

/** Valid sub directory. */
const subArb: fc.Arbitrary<"inputs" | "outputs"> = fc.constantFrom("inputs", "outputs");

/** Arbitrary relKey — intentionally includes malicious patterns. */
const anyRelKeyArb = fc.oneof(
  // Good keys
  fc.stringMatching(/^[a-z0-9_]{1,20}\.[a-z]{2,4}$/),
  // Keys with subdirs
  fc.stringMatching(/^[a-z0-9_]{1,10}\/[a-z0-9_]{1,10}\.[a-z]{2,4}$/),
  // Traversal attacks
  fc.constant("../../../etc/passwd"),
  fc.constant("../../secret.txt"),
  fc.constant(".."),
  fc.constant("foo/../../../bar"),
  fc.constant("foo/../../.."),
  // Absolute paths
  fc.constant("/etc/passwd"),
  fc.constant("/tmp/evil"),
  fc.constant("C:\\Windows\\System32\\config"),
  // Backslash attacks
  fc.constant("foo\\..\\..\\secret"),
  fc.constant("..\\..\\etc\\passwd"),
  // Empty / whitespace
  fc.constant(""),
  fc.constant("   "),
  // Completely random strings
  fc.string({ minLength: 0, maxLength: 80 })
);

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe("deriveKey — Property: Least-Privilege Key Confinement (P6)", () => {
  it("every successful key is strictly under edit-io/<editJobId>/<sub>/", () => {
    fc.assert(
      fc.property(validEditJobIdArb, subArb, anyRelKeyArb, (editJobId, sub, relKey) => {
        const expectedPrefix = `edit-io/${editJobId}/${sub}/`;
        try {
          const key = deriveKey(editJobId, sub, relKey);
          // If it succeeds, the key MUST start with the expected prefix
          expect(key.startsWith(expectedPrefix)).toBe(true);
          // The key must not contain ".." after derivation
          expect(key.includes("..")).toBe(false);
          // The key must not start with "/"
          expect(key.startsWith("/")).toBe(false);
          // The key must be strictly longer than the prefix (non-empty relative part)
          expect(key.length).toBeGreaterThan(expectedPrefix.length - 1);
        } catch (err) {
          // If it throws, it MUST be a KeyConfinementError
          expect(err).toBeInstanceOf(KeyConfinementError);
        }
      }),
      { numRuns: 1000 }
    );
  });

  it("traversal patterns always throw KeyConfinementError", () => {
    const traversalKeys = [
      "../secret",
      "../../etc/passwd",
      "foo/../../../bar",
      "..\\..\\etc\\passwd",
      "/etc/passwd",
      "/tmp/evil",
      "C:\\Windows\\System32",
      "",
      "   ",
    ];

    for (const relKey of traversalKeys) {
      expect(() => deriveKey("test-job-id", "inputs", relKey)).toThrow(
        KeyConfinementError
      );
    }
  });

  it("valid simple filenames always succeed and are confined", () => {
    fc.assert(
      fc.property(
        validEditJobIdArb,
        subArb,
        fc.stringMatching(/^[a-z0-9_]{1,20}\.[a-z]{2,4}$/),
        (editJobId, sub, relKey) => {
          const key = deriveKey(editJobId, sub, relKey);
          expect(key).toBe(`edit-io/${editJobId}/${sub}/${relKey}`);
        }
      ),
      { numRuns: 500 }
    );
  });
});
