/**
 * Property-based test: State-machine totality.
 *
 * **Property 1: State-machine totality (every awaiting estado is actionable)**
 * **Validates: Requirements 5.1, 5.2, 5.3, 5.5**
 *
 * For arbitrary estado strings drawn from the editor enum (with case/whitespace
 * perturbations), mapEditorEstado yields a defined status among the 8 known
 * values, and the three awaiting estados map to control-backed awaiting_*
 * statuses. For arbitrary unknown strings, the result is a defined `failed`
 * with a non-null {paso:"STATUS_MAPPING"} error.
 *
 * Uses fast-check for property-based testing.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { mapEditorEstado } from "../statusMap";
import type { EditJobStatus } from "../types";

const KNOWN: Record<string, EditJobStatus> = {
  en_cola: "queued",
  en_ejecucion: "running",
  esperando_edicion_silencios: "awaiting_silences",
  esperando_revision: "awaiting_subtitles",
  esperando_edicion_final: "awaiting_final_render",
  completado: "completed",
  fallido: "failed",
};

const ALL_STATUSES: EditJobStatus[] = [
  "queued",
  "uploading",
  "running",
  "awaiting_silences",
  "awaiting_subtitles",
  "awaiting_final_render",
  "completed",
  "failed",
];

const AWAITING_ESTADOS = [
  "esperando_edicion_silencios",
  "esperando_revision",
  "esperando_edicion_final",
];

// Perturb a known estado with case flips and surrounding whitespace.
function perturb(estado: string, upper: boolean, pad: string): string {
  const cased = upper ? estado.toUpperCase() : estado;
  return `${pad}${cased}${pad}`;
}

describe("Property 1 — State-machine totality", () => {
  it("every known estado (with case/whitespace) maps deterministically to a defined status", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...Object.keys(KNOWN)),
        fc.boolean(),
        fc.constantFrom("", " ", "  ", "\t"),
        (estado, upper, pad) => {
          const result = mapEditorEstado(perturb(estado, upper, pad));
          expect(ALL_STATUSES).toContain(result.status);
          expect(result.status).toBe(KNOWN[estado]);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("the three awaiting estados always map to control-backed awaiting_* statuses", () => {
    fc.assert(
      fc.property(fc.constantFrom(...AWAITING_ESTADOS), fc.boolean(), (estado, upper) => {
        const result = mapEditorEstado(upper ? estado.toUpperCase() : estado);
        expect([
          "awaiting_silences",
          "awaiting_subtitles",
          "awaiting_final_render",
        ]).toContain(result.status);
        expect(result.status).not.toBe("awaiting_edit");
        expect(result.error).toBeNull();
      }),
      { numRuns: 200 },
    );
  });

  it("arbitrary unknown estado strings map to a defined failed with STATUS_MAPPING", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const normalized = raw.toLowerCase().trim();
        fc.pre(!(normalized in KNOWN));
        const result = mapEditorEstado(raw);
        expect(result.status).toBe("failed");
        expect(result.error).not.toBeNull();
        expect(result.error!.paso).toBe("STATUS_MAPPING");
      }),
      { numRuns: 300 },
    );
  });
});
