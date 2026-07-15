/**
 * Unit tests for the editor estado → normalized status mapping
 * and ordering validation logic.
 *
 * Covers:
 * - Each known estado mapping
 * - Unrecognized estado → failed case
 * - Ordering validation edge cases
 *
 * Requirements: 4, 8
 */

import { describe, it, expect } from "vitest";
import { mapEditorEstado, validateOrdering } from "../statusMap";
import type { ClipOrderEntry } from "../types";

// ---------------------------------------------------------------------------
// mapEditorEstado tests
// ---------------------------------------------------------------------------

describe("mapEditorEstado", () => {
  it("maps en_cola → queued", () => {
    const result = mapEditorEstado("en_cola");
    expect(result.status).toBe("queued");
    expect(result.error).toBeNull();
  });

  it("maps en_ejecucion → running", () => {
    const result = mapEditorEstado("en_ejecucion");
    expect(result.status).toBe("running");
    expect(result.error).toBeNull();
  });

  it("maps esperando_edicion_silencios → awaiting_edit", () => {
    const result = mapEditorEstado("esperando_edicion_silencios");
    expect(result.status).toBe("awaiting_edit");
    expect(result.error).toBeNull();
  });

  it("maps esperando_revision → awaiting_edit", () => {
    const result = mapEditorEstado("esperando_revision");
    expect(result.status).toBe("awaiting_edit");
    expect(result.error).toBeNull();
  });

  it("maps esperando_edicion_final → awaiting_edit", () => {
    const result = mapEditorEstado("esperando_edicion_final");
    expect(result.status).toBe("awaiting_edit");
    expect(result.error).toBeNull();
  });

  it("maps completado → completed", () => {
    const result = mapEditorEstado("completado");
    expect(result.status).toBe("completed");
    expect(result.error).toBeNull();
  });

  it("maps fallido → failed", () => {
    const result = mapEditorEstado("fallido");
    expect(result.status).toBe("failed");
    expect(result.error).toBeNull();
  });

  it("is case-insensitive (EN_COLA → queued)", () => {
    const result = mapEditorEstado("EN_COLA");
    expect(result.status).toBe("queued");
    expect(result.error).toBeNull();
  });

  it("is case-insensitive (En_Ejecucion → running)", () => {
    const result = mapEditorEstado("En_Ejecucion");
    expect(result.status).toBe("running");
    expect(result.error).toBeNull();
  });

  it("trims whitespace", () => {
    const result = mapEditorEstado("  completado  ");
    expect(result.status).toBe("completed");
    expect(result.error).toBeNull();
  });

  it("unrecognized estado → failed with error", () => {
    const result = mapEditorEstado("desconocido");
    expect(result.status).toBe("failed");
    expect(result.error).not.toBeNull();
    expect(result.error!.paso).toBe("STATUS_MAPPING");
    expect(result.error!.motivo).toContain("desconocido");
  });

  it("empty string → failed with error", () => {
    const result = mapEditorEstado("");
    expect(result.status).toBe("failed");
    expect(result.error).not.toBeNull();
    expect(result.error!.paso).toBe("STATUS_MAPPING");
  });

  it("random garbage → failed with error", () => {
    const result = mapEditorEstado("xyz_not_a_real_status_123");
    expect(result.status).toBe("failed");
    expect(result.error).not.toBeNull();
    expect(result.error!.motivo).toContain("xyz_not_a_real_status_123");
  });
});

// ---------------------------------------------------------------------------
// validateOrdering tests
// ---------------------------------------------------------------------------

describe("validateOrdering", () => {
  it("accepts a valid single-entry ordering", () => {
    const ordering: ClipOrderEntry[] = [
      { index: 0, clipId: "clip-a", isBroll: false },
    ];
    expect(validateOrdering(ordering).success).toBe(true);
  });

  it("accepts a valid multi-entry ordering (contiguous indexes)", () => {
    const ordering: ClipOrderEntry[] = [
      { index: 0, clipId: "clip-a", isBroll: false },
      { index: 1, clipId: "clip-b", isBroll: true },
      { index: 2, clipId: "clip-c", isBroll: false },
    ];
    expect(validateOrdering(ordering).success).toBe(true);
  });

  it("accepts a valid ordering where entries are not sorted by index (permutation)", () => {
    const ordering: ClipOrderEntry[] = [
      { index: 2, clipId: "clip-c", isBroll: false },
      { index: 0, clipId: "clip-a", isBroll: false },
      { index: 1, clipId: "clip-b", isBroll: true },
    ];
    expect(validateOrdering(ordering).success).toBe(true);
  });

  it("rejects an empty ordering", () => {
    const result = validateOrdering([]);
    expect(result.success).toBe(false);
    expect(result.error).toContain("at least 1");
  });

  it("rejects ordering exceeding MAX_CLIPS_PER_JOB (>500)", () => {
    // Create 501 entries
    const ordering: ClipOrderEntry[] = Array.from({ length: 501 }, (_, i) => ({
      index: i,
      clipId: `clip-${i}`,
      isBroll: false,
    }));
    const result = validateOrdering(ordering);
    expect(result.success).toBe(false);
    expect(result.error).toContain("500");
  });

  it("rejects ordering with duplicate indexes", () => {
    const ordering: ClipOrderEntry[] = [
      { index: 0, clipId: "clip-a", isBroll: false },
      { index: 0, clipId: "clip-b", isBroll: true },
    ];
    const result = validateOrdering(ordering);
    expect(result.success).toBe(false);
    expect(result.error).toContain("unique");
  });

  it("rejects non-contiguous indexes (gap)", () => {
    const ordering: ClipOrderEntry[] = [
      { index: 0, clipId: "clip-a", isBroll: false },
      { index: 2, clipId: "clip-c", isBroll: false },
    ];
    const result = validateOrdering(ordering);
    expect(result.success).toBe(false);
    expect(result.error).toContain("contiguous");
  });

  it("rejects out-of-range indexes (not starting from 0)", () => {
    const ordering: ClipOrderEntry[] = [
      { index: 1, clipId: "clip-a", isBroll: false },
      { index: 2, clipId: "clip-b", isBroll: false },
    ];
    const result = validateOrdering(ordering);
    expect(result.success).toBe(false);
    expect(result.error).toContain("contiguous");
  });

  it("rejects entry with empty clipId", () => {
    const ordering: ClipOrderEntry[] = [
      { index: 0, clipId: "", isBroll: false },
    ];
    const result = validateOrdering(ordering);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid entry");
  });

  it("rejects entry with negative index", () => {
    const ordering: ClipOrderEntry[] = [
      { index: -1, clipId: "clip-a", isBroll: false },
    ];
    const result = validateOrdering(ordering);
    expect(result.success).toBe(false);
    // Negative index fails Zod nonnegative check
    expect(result.error).toContain("Invalid entry");
  });

  it("accepts exactly MAX_CLIPS_PER_JOB entries (500)", () => {
    const ordering: ClipOrderEntry[] = Array.from({ length: 500 }, (_, i) => ({
      index: i,
      clipId: `clip-${i}`,
      isBroll: false,
    }));
    const result = validateOrdering(ordering);
    expect(result.success).toBe(true);
  });
});
