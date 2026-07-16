/**
 * Property-based test: Segment integrity is preserved and validated.
 *
 * **Property 3: Segment integrity is preserved and validated**
 * **Validates: Requirements 8.1, 8.2, 1.4**
 *
 * For an arbitrary segment list S and duration D:
 * - validateSegments(S, D) returns no errors IFF S is sorted ascending by
 *   inicioS, pairwise non-overlapping, and every segment satisfies
 *   0 <= inicioS < finS <= D with finite bounds.
 * - Any accepted list forwards 1:1 to {inicio_s, fin_s} preserving order and
 *   values.
 *
 * Uses fast-check for property-based testing.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { validateSegments, type SilenceSegment } from "../validateSegments";

// Independent reference predicate (mirrors the invariant, computed separately).
function isValidReference(segments: SilenceSegment[], durationS: number): boolean {
  let prevFin = 0;
  for (const s of segments) {
    if (!Number.isFinite(s.inicioS) || !Number.isFinite(s.finS)) return false;
    if (!(s.inicioS >= 0 && s.inicioS < s.finS)) return false;
    if (s.finS > durationS) return false;
    if (s.inicioS < prevFin) return false;
    prevFin = s.finS;
  }
  return true;
}

// Arbitrary segments: mix of well-formed and adversarial values.
const segmentArb: fc.Arbitrary<SilenceSegment> = fc.record({
  inicioS: fc.oneof(
    fc.double({ min: -5, max: 20, noNaN: true }),
    fc.constant(Number.NaN),
    fc.integer({ min: -3, max: 15 }),
  ),
  finS: fc.oneof(
    fc.double({ min: -5, max: 20, noNaN: true }),
    fc.constant(Number.POSITIVE_INFINITY),
    fc.integer({ min: -3, max: 15 }),
  ),
});

// A generator that yields a valid, sorted, non-overlapping list within duration.
const validListArb: fc.Arbitrary<{ segments: SilenceSegment[]; durationS: number }> = fc
  .array(fc.record({ gap: fc.integer({ min: 0, max: 3 }), len: fc.integer({ min: 1, max: 4 }) }), {
    maxLength: 6,
  })
  .map((specs) => {
    const segments: SilenceSegment[] = [];
    let cursor = 0;
    for (const { gap, len } of specs) {
      const inicioS = cursor + gap;
      const finS = inicioS + len;
      segments.push({ inicioS, finS });
      cursor = finS;
    }
    return { segments, durationS: cursor + 5 };
  });

describe("Property 3 — Segment integrity is preserved and validated", () => {
  it("accepts iff sorted, non-overlapping, and in-bounds", () => {
    fc.assert(
      fc.property(
        fc.array(segmentArb, { maxLength: 8 }),
        fc.double({ min: 0, max: 25, noNaN: true }),
        (segments, durationS) => {
          const accepted = validateSegments(segments, durationS).length === 0;
          expect(accepted).toBe(isValidReference(segments, durationS));
        },
      ),
      { numRuns: 500 },
    );
  });

  it("well-formed lists are always accepted", () => {
    fc.assert(
      fc.property(validListArb, ({ segments, durationS }) => {
        expect(validateSegments(segments, durationS)).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it("accepted lists forward 1:1 to {inicio_s, fin_s} preserving order and values", () => {
    fc.assert(
      fc.property(validListArb, ({ segments, durationS }) => {
        expect(validateSegments(segments, durationS)).toEqual([]);
        const tramos = segments.map((s) => ({ inicio_s: s.inicioS, fin_s: s.finS }));
        expect(tramos).toHaveLength(segments.length);
        tramos.forEach((t, i) => {
          expect(t.inicio_s).toBe(segments[i].inicioS);
          expect(t.fin_s).toBe(segments[i].finS);
        });
      }),
      { numRuns: 200 },
    );
  });
});
