/**
 * Property-based test: Automatic behavior preserved.
 *
 * **Property 6: Automatic behavior preserved**
 * **Validates: Requirements 7.1, 7.2, 7.3**
 *
 * For jobs where a pause does not apply (silences disabled ⇒ the editor never
 * reports esperando_edicion_silencios; no review flag ⇒ never
 * esperando_revision), the generator never enters the corresponding awaiting_*
 * status and proceeds running → … → completed via the poll loop, exactly as
 * before this feature.
 *
 * Uses fast-check for property-based testing.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { mapEditorEstado } from "../statusMap";
import { reconcileEditJob, type ReconcileDeps } from "../jobReconciler";
import type { EditJob } from "../types";
import type { EditJobStore } from "../editJobStore";

function createStore(job: EditJob): EditJobStore {
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
    listEditJobs: () => Array.from(jobs.values()),
  };
}

function makeJob(): EditJob {
  return {
    id: "job-1",
    projectId: "proj-1",
    source: { type: "clips", clipIds: ["c1"] },
    options: { silenceCut: false, subtitles: false },
    status: "running",
    editorJobId: "editor-1",
    progress: { porcentaje: 10, pasoActual: null, mensaje: "", error: null },
    outputKey: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// Estados the editor reports when the silence + subtitle-review pauses do not
// apply: it runs, may reach the always-on final pause, then completes.
const NON_PAUSE_ESTADOS = ["en_ejecucion", "esperando_edicion_final", "completado"] as const;

function makeDeps(store: EditJobStore, estados: string[]): ReconcileDeps {
  let i = 0;
  // Durable output only appears once the editor has reported "completado",
  // mirroring the real pipeline (final.mp4 is written at the end).
  const shared = { completedEmitted: false };
  return {
    editJobStore: store,
    createClient: () =>
      ({
        baseUrl: "http://localhost:8000",
        progreso: async () => {
          const estado = estados[Math.min(i, estados.length - 1)];
          i += 1;
          if (estado === "completado") shared.completedEmitted = true;
          return { porcentaje: 50, paso_actual: "STEP", mensaje: "", error: null, estado } as any;
        },
      }) as any,
    getStorageAdapter: () =>
      ({
        persistOutput: async () =>
          shared.completedEmitted ? "edit-output/job-1/final.mp4" : undefined,
      }) as any,
  };
}

describe("Property 6 — Automatic behavior preserved", () => {
  it("mapEditorEstado never yields awaiting_silences/subtitles for non-pause estados", () => {
    fc.assert(
      fc.property(fc.constantFrom(...NON_PAUSE_ESTADOS), (estado) => {
        const status = mapEditorEstado(estado).status;
        expect(status).not.toBe("awaiting_silences");
        expect(status).not.toBe("awaiting_subtitles");
      }),
      { numRuns: 100 },
    );
  });

  it("reconcile over non-pause estado sequences never enters the skipped awaiting states", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("en_ejecucion", "esperando_edicion_final"), {
          minLength: 1,
          maxLength: 10,
        }),
        async (mid) => {
          const store = createStore(makeJob());
          // A trailing "completado" plus the durable final.mp4 resolves to completed.
          const deps = makeDeps(store, [...mid, "completado"]);
          for (let n = 0; n < mid.length + 1; n++) {
            const result = await reconcileEditJob("job-1", deps);
            const status = result!.job.status;
            expect(status).not.toBe("awaiting_silences");
            expect(status).not.toBe("awaiting_subtitles");
            if (status === "completed") break;
          }
          // Terminal reachable: the durable output resolves it to completed.
          expect(store.getEditJob("job-1")?.status).toBe("completed");
        },
      ),
      { numRuns: 150 },
    );
  });
});
