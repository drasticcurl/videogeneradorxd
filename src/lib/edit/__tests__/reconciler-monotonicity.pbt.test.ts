/**
 * Property-based test: Percent monotonicity across pauses.
 *
 * **Property 8: Percent monotonicity across pauses**
 * **Validates: Requirements 9.1, 9.2, 9.3**
 *
 * For arbitrary reconcile sequences — including pause→resume transitions
 * (running → awaiting_* → running) — the persisted progress.porcentaje is
 * non-decreasing and clamped to [0, 100].
 *
 * Uses fast-check for property-based testing.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { reconcileEditJob, type ReconcileDeps } from "../jobReconciler";
import type { EditJob } from "../types";
import type { EditJobStore } from "../editJobStore";

function createInMemoryStore(job: EditJob): EditJobStore {
  const jobs = new Map<string, EditJob>([[job.id, job]]);
  return {
    createEditJob: async (j) => {
      jobs.set(j.id, j);
      return j;
    },
    getEditJob: (id) => jobs.get(id),
    updateEditJob: async (id, patch) => {
      const existing = jobs.get(id);
      if (!existing) return undefined;
      const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      jobs.set(id, updated);
      return updated;
    },
    listEditJobs: (projectId) =>
      Array.from(jobs.values()).filter((j) => j.projectId === projectId),
  };
}

function baseJob(): EditJob {
  return {
    id: "job-1",
    projectId: "proj-1",
    source: { type: "clips", clipIds: ["c1"] },
    options: { silenceCut: true, subtitles: true },
    status: "running",
    editorJobId: "editor-1",
    progress: { porcentaje: 0, pasoActual: null, mensaje: "", error: null },
    outputKey: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// A reconcile "tick" the editor reports: an arbitrary (possibly regressing,
// possibly out-of-range) percentage plus a non-terminal estado.
const tickArb = fc.record({
  porcentaje: fc.integer({ min: -50, max: 150 }),
  estado: fc.constantFrom(
    "en_ejecucion",
    "esperando_edicion_silencios",
    "esperando_revision",
    "esperando_edicion_final",
  ),
});

// Deps whose client returns a scripted sequence of ticks; storage never has a
// durable output so the reconciler follows the live-progress path.
function makeDeps(store: EditJobStore, ticks: { porcentaje: number; estado: string }[]): ReconcileDeps {
  let i = 0;
  return {
    editJobStore: store,
    createClient: () =>
      ({
        baseUrl: "http://localhost:8000",
        progreso: async () => {
          const tick = ticks[Math.min(i, ticks.length - 1)];
          i += 1;
          return {
            porcentaje: tick.porcentaje,
            paso_actual: "STEP",
            mensaje: "tick",
            error: null,
            estado: tick.estado,
          } as any;
        },
      }) as any,
    getStorageAdapter: () =>
      ({
        persistOutput: async () => undefined,
        signedGetUrl: async () => undefined,
        getOutputStream: async () => new Uint8Array(),
        putInput: async () => "",
        toEditorInputReference: async () => "",
      }) as any,
  };
}

describe("Property 8 — Percent monotonicity across pauses", () => {
  it("porcentaje is non-decreasing and clamped to [0,100] across reconcile sequences", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(tickArb, { minLength: 1, maxLength: 30 }), async (ticks) => {
        const store = createInMemoryStore(baseJob());
        const deps = makeDeps(store, ticks);
        let prev = 0;
        for (let n = 0; n < ticks.length; n++) {
          const result = await reconcileEditJob("job-1", deps);
          const current = result!.job.progress.porcentaje;
          expect(current).toBeGreaterThanOrEqual(0);
          expect(current).toBeLessThanOrEqual(100);
          expect(Number.isInteger(current)).toBe(true);
          expect(current).toBeGreaterThanOrEqual(prev);
          prev = current;
        }
      }),
      { numRuns: 200 },
    );
  });
});
