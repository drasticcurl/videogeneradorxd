/**
 * Shared silence-segment validation invariant.
 *
 * Enforced BFF-side (silences POST route) and mirrored client-side
 * (SilenceTimeline) so malformed cut segments fail fast with clear per-segment
 * messages before ever reaching the editor. The editor re-validates as a second
 * layer of defense.
 *
 * Rules (a list is valid iff every rule holds for every segment):
 * - Finite numeric bounds: `inicioS` and `finS` are finite numbers.
 * - Ordering within a segment: `0 <= inicioS < finS`.
 * - Within the joined-video duration: `finS <= durationS`.
 * - Sorted ascending by `inicioS` and pairwise non-overlapping:
 *   `segment[i].finS <= segment[i+1].inicioS`.
 *
 * Requirements: 8.1, 8.2
 */

/** A cut range in generator (camelCase) form. */
export interface SilenceSegment {
  inicioS: number;
  finS: number;
}

/** A single per-segment validation error. */
export interface SegmentError {
  /** Zero-based index of the offending segment. */
  index: number;
  /** Human-readable reason the segment is invalid. */
  reason: string;
}

/**
 * Validates a list of silence segments against the shared invariant.
 *
 * @returns an array of per-segment errors; an empty array means the list is
 * valid. A single segment may accumulate multiple errors.
 */
export function validateSegments(
  segments: SilenceSegment[],
  durationS: number,
): SegmentError[] {
  const errors: SegmentError[] = [];
  let prevFin = 0;

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const inicio = s?.inicioS;
    const fin = s?.finS;

    if (!Number.isFinite(inicio) || !Number.isFinite(fin)) {
      errors.push({ index: i, reason: "non-numeric or non-finite bounds" });
      // Cannot reason about ordering with non-finite values; advance and skip.
      prevFin = Number.isFinite(fin) ? fin : prevFin;
      continue;
    }

    if (!(inicio >= 0 && inicio < fin)) {
      errors.push({ index: i, reason: "require 0 <= inicioS < finS" });
    }
    if (fin > durationS) {
      errors.push({ index: i, reason: "exceeds duration" });
    }
    if (inicio < prevFin) {
      errors.push({ index: i, reason: "overlaps previous or not sorted" });
    }

    prevFin = fin;
  }

  return errors;
}
