/**
 * Property-based test: Progress monotonicity end-to-end.
 *
 * Property 2: For any sequence of editor progress reads applied to the reducer,
 * the resulting porcentaje is non-decreasing and within [0, 100].
 *
 * **Validates: Requirements 5.2, 5.3, 8.3**
 *
 * Uses fast-check for property-based testing.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { editJobReducer, EditJobAction } from "../editJobReducer";
import type { EditJob, EditorProgress } from "../types";

// ---------------------------------------------------------------------------
// Helpers: create a job that is already in "running" state (the state where
// progress updates are meaningful).
// ---------------------------------------------------------------------------

function makeRunningJob(): EditJob {
  const progress: EditorProgress = {
    porcentaje: 0,
    pasoActual: null,
    mensaje: "",
    error: null,
  };
  return {
    id: "test-job-001",
    source: { type: "clips", clipIds: ["clip1"] },
    options: { silenceCut: true, subtitles: true },
    status: "running",
    editorJobId: "editor_job_abc",
    progress,
    outputKey: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Smart generator: generates a sequence of PROGRESS_UPDATE actions with
// arbitrary porcentaje values (including out-of-range and negative).
// ---------------------------------------------------------------------------

const progressUpdateArb: fc.Arbitrary<EditJobAction> = fc.record({
  type: fc.constant("PROGRESS_UPDATE" as const),
  porcentaje: fc.integer({ min: -200, max: 300 }), // intentionally wider than [0,100]
  pasoActual: fc.oneof(
    fc.constant(null),
    fc.constantFrom("UNIR", "CORTAR_SILENCIOS", "TRANSCRIBIR", "SUBTITULOS", "MUSICA")
  ),
  mensaje: fc.string({ maxLength: 50 }),
});

const progressSequenceArb: fc.Arbitrary<EditJobAction[]> = fc.array(progressUpdateArb, {
  minLength: 1,
  maxLength: 100,
});

// ---------------------------------------------------------------------------
// Property test
// ---------------------------------------------------------------------------

describe("EditJob Reducer — Property: Progress Monotonicity (P2)", () => {
  it("porcentaje is non-decreasing and within [0, 100] for any sequence of progress updates", () => {
    fc.assert(
      fc.property(progressSequenceArb, (actions) => {
        let state = makeRunningJob();
        let prevPorcentaje = state.progress.porcentaje;

        for (const action of actions) {
          state = editJobReducer(state, action);
          const current = state.progress.porcentaje;

          // Within bounds
          expect(current).toBeGreaterThanOrEqual(0);
          expect(current).toBeLessThanOrEqual(100);

          // Integer
          expect(Number.isInteger(current)).toBe(true);

          // Non-decreasing
          expect(current).toBeGreaterThanOrEqual(prevPorcentaje);

          prevPorcentaje = current;
        }
      }),
      { numRuns: 500, verbose: true }
    );
  });

  it("porcentaje stays at 0 when all incoming values are negative or zero", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.integer({ min: -1000, max: 0 }),
          { minLength: 1, maxLength: 50 }
        ),
        (values) => {
          let state = makeRunningJob();
          for (const v of values) {
            state = editJobReducer(state, {
              type: "PROGRESS_UPDATE",
              porcentaje: v,
              pasoActual: null,
              mensaje: "",
            });
            expect(state.progress.porcentaje).toBe(0);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it("porcentaje caps at 100 when incoming values exceed 100", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.integer({ min: 101, max: 5000 }),
          { minLength: 1, maxLength: 20 }
        ),
        (values) => {
          let state = makeRunningJob();
          for (const v of values) {
            state = editJobReducer(state, {
              type: "PROGRESS_UPDATE",
              porcentaje: v,
              pasoActual: null,
              mensaje: "",
            });
            // After first update with >100, it should cap at 100
            expect(state.progress.porcentaje).toBe(100);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
