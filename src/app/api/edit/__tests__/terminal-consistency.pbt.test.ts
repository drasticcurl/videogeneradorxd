/**
 * Property-based test: Terminal consistency (Property 3).
 *
 * Property 3: completed => outputKey exists and result serves it;
 *             failed => error present and no partial artifact advertised.
 *
 * **Validates: Requirements 6.2, 6.9, 6.10**
 *
 * Uses fast-check for property-based testing.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { editJobReducer } from "@/lib/edit/editJobReducer";
import type { EditJob, EditJobStatus, EditorProgress, EditJobError } from "@/lib/edit/types";

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const editJobErrorArb: fc.Arbitrary<EditJobError> = fc.record({
  paso: fc.constantFrom("UNIR", "CORTAR_SILENCIOS", "TRANSCRIBIR", "SUBTITULOS", "MUSICA", "UPLOAD", "PROCESAR"),
  motivo: fc.string({ minLength: 1, maxLength: 100 }),
});

const outputKeyArb: fc.Arbitrary<string> = fc.tuple(
  fc.uuid(),
  fc.constantFrom("final.mp4", "output.mp4", "edited_result.mp4")
).map(([id, name]) => `edit-io/${id}/outputs/${name}`);

const progressArb: fc.Arbitrary<EditorProgress> = fc.record({
  porcentaje: fc.integer({ min: 0, max: 100 }),
  pasoActual: fc.oneof(
    fc.constant(null),
    fc.constantFrom("UNIR", "CORTAR_SILENCIOS", "TRANSCRIBIR", "SUBTITULOS", "MUSICA")
  ),
  mensaje: fc.string({ maxLength: 50 }),
  error: fc.oneof(fc.constant(null), editJobErrorArb),
});

/**
 * Generate an EditJob that is in a terminal state (completed or failed).
 * The generator ensures the invariants are correct:
 * - completed: outputKey present, error null
 * - failed: error present, no outputKey advertised
 */
const completedJobArb: fc.Arbitrary<EditJob> = fc.record({
  id: fc.uuid(),
  projectId: fc.string({ minLength: 1, maxLength: 20 }),
  source: fc.constant({ type: "clips" as const, clipIds: ["clip1"] }),
  options: fc.constant({ silenceCut: true, subtitles: false }),
  status: fc.constant("completed" as const),
  editorJobId: fc.oneof(fc.uuid(), fc.constant(null)),
  progress: progressArb.map((p) => ({ ...p, porcentaje: 100, error: null })),
  outputKey: outputKeyArb,
  error: fc.constant(null),
  createdAt: fc.constant(new Date().toISOString()),
  updatedAt: fc.constant(new Date().toISOString()),
});

const failedJobArb: fc.Arbitrary<EditJob> = fc.record({
  id: fc.uuid(),
  projectId: fc.string({ minLength: 1, maxLength: 20 }),
  source: fc.constant({ type: "clips" as const, clipIds: ["clip1"] }),
  options: fc.constant({ silenceCut: true, subtitles: false }),
  status: fc.constant("failed" as const),
  editorJobId: fc.oneof(fc.uuid(), fc.constant(null)),
  progress: progressArb.map((p) => ({ ...p, error: p.error ?? { paso: "UNKNOWN", motivo: "error" } })),
  outputKey: fc.constant(null),
  error: editJobErrorArb,
  createdAt: fc.constant(new Date().toISOString()),
  updatedAt: fc.constant(new Date().toISOString()),
});

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe("Terminal Consistency — Property 3 (P3)", () => {
  it("completed job always has an outputKey present and non-empty", () => {
    fc.assert(
      fc.property(completedJobArb, (job) => {
        // P3: completed => outputKey exists
        expect(job.status).toBe("completed");
        expect(job.outputKey).not.toBeNull();
        expect(typeof job.outputKey).toBe("string");
        expect(job.outputKey!.length).toBeGreaterThan(0);
        // No error on completed job
        expect(job.error).toBeNull();
      }),
      { numRuns: 300, verbose: true }
    );
  });

  it("failed job always has an error present and no partial artifact advertised", () => {
    fc.assert(
      fc.property(failedJobArb, (job) => {
        // P3: failed => error present
        expect(job.status).toBe("failed");
        expect(job.error).not.toBeNull();
        expect(typeof job.error!.paso).toBe("string");
        expect(job.error!.paso.length).toBeGreaterThan(0);
        expect(typeof job.error!.motivo).toBe("string");
        expect(job.error!.motivo.length).toBeGreaterThan(0);
        // No partial artifact advertised
        expect(job.outputKey).toBeNull();
      }),
      { numRuns: 300, verbose: true }
    );
  });

  it("the editJobReducer COMPLETED action always sets outputKey and clears error", () => {
    fc.assert(
      fc.property(
        outputKeyArb,
        fc.integer({ min: 0, max: 99 }),
        (outputKey, currentPorcentaje) => {
          const runningJob: EditJob = {
            id: "test-id",
            projectId: "proj",
            source: { type: "clips", clipIds: ["c1"] },
            options: { silenceCut: true, subtitles: false },
            status: "running",
            editorJobId: "editor-123",
            progress: { porcentaje: currentPorcentaje, pasoActual: null, mensaje: "", error: null },
            outputKey: null,
            error: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };

          const result = editJobReducer(runningJob, { type: "COMPLETED", outputKey });

          // Verify terminal consistency
          expect(result.status).toBe("completed");
          expect(result.outputKey).toBe(outputKey);
          expect(result.error).toBeNull();
          expect(result.progress.porcentaje).toBe(100);
        }
      ),
      { numRuns: 200 }
    );
  });

  it("the editJobReducer FAILED action always sets error and never sets outputKey", () => {
    fc.assert(
      fc.property(
        editJobErrorArb,
        fc.integer({ min: 0, max: 100 }),
        (error, currentPorcentaje) => {
          const runningJob: EditJob = {
            id: "test-id",
            projectId: "proj",
            source: { type: "clips", clipIds: ["c1"] },
            options: { silenceCut: true, subtitles: false },
            status: "running",
            editorJobId: "editor-123",
            progress: { porcentaje: currentPorcentaje, pasoActual: null, mensaje: "", error: null },
            outputKey: null,
            error: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };

          const result = editJobReducer(runningJob, { type: "FAILED", error });

          // Verify terminal consistency
          expect(result.status).toBe("failed");
          expect(result.error).toEqual(error);
          expect(result.outputKey).toBeNull();
          // progress.error should be set
          expect(result.progress.error).toEqual(error);
        }
      ),
      { numRuns: 200 }
    );
  });
});
