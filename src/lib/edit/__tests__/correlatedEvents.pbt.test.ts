/**
 * Task 3.4 — End-to-end correlated events (Property 1), Next.js reconciler side.
 *
 * **Validates: Requirements 2.1, 2.2, 2.5**
 *
 * These tests pin the additive correlation tuple threaded onto every reconcile
 * result (`{version, revision, editJobId, editorJobId}`), so a job at the opaque
 * 25% boundary is observable/classifiable (category C) from a correlated event —
 * independent of the (monotonic) percentage, which is NEVER used as the state.
 * Video content is never carried through the reconciled view.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { reconcileEditJob, type ReconcileDeps } from "../jobReconciler";
import { EditorPermanentError } from "../retry";
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

function makeJob(overrides: Partial<EditJob> = {}): EditJob {
  return {
    id: "edit-job-1",
    projectId: "proj-1",
    source: { type: "clips", clipIds: ["c1", "c2"] },
    options: { silenceCut: true, subtitles: true },
    status: "running",
    editorJobId: "editor-1",
    progress: { porcentaje: 25, pasoActual: "CORTAR_SILENCIOS", mensaje: "", error: null },
    outputKey: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function depsWith(store: EditJobStore, progresoImpl: () => Promise<any>): ReconcileDeps {
  return {
    editJobStore: store,
    createClient: () => ({ baseUrl: "http://localhost:8000", progreso: progresoImpl } as any),
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

describe("Task 3.4 — reconcile results carry the correlation tuple", () => {
  it("attaches {editJobId, editorJobId} to an awaiting_silences pause", async () => {
    const store = createInMemoryStore(makeJob());
    const deps = depsWith(store, async () => ({
      porcentaje: 25,
      paso_actual: "CORTAR_SILENCIOS",
      mensaje: "Esperando edición manual de silencios",
      error: null,
      estado: "esperando_edicion_silencios",
    }));
    const result = await reconcileEditJob("edit-job-1", deps);
    expect(result?.job.status).toBe("awaiting_silences");
    expect(result?.correlation).toBeDefined();
    expect(result?.correlation?.editJobId).toBe("edit-job-1");
    expect(result?.correlation?.editorJobId).toBe("editor-1");
  });

  it("attaches correlation on the EDITOR_STATE_LOST failure (category C)", async () => {
    const store = createInMemoryStore(makeJob({ status: "awaiting_silences" }));
    const deps = depsWith(store, async () => {
      throw new EditorPermanentError("gone", 404);
    });
    const result = await reconcileEditJob("edit-job-1", deps);
    expect(result?.job.status).toBe("failed");
    expect(result?.job.error?.paso).toBe("EDITOR_STATE_LOST");
    expect(result?.correlation?.editJobId).toBe("edit-job-1");
  });

  it("never surfaces video content from the editor progress", async () => {
    const store = createInMemoryStore(makeJob());
    const deps = depsWith(store, async () => ({
      porcentaje: 25,
      paso_actual: "UNIR",
      mensaje: "Uniendo",
      error: null,
      estado: "en_ejecucion",
      // Fields like these must never leak into the reconciled result.
      video_url: "http://loopback/internal/video.mp4",
      video_bytes: "AAAA",
    }));
    const result = await reconcileEditJob("edit-job-1", deps);
    const blob = JSON.stringify(result);
    expect(blob).not.toContain("video");
    expect(blob).not.toContain("loopback");
  });
});

// A reconcile "tick": the step/substep/state changes while the percentage is
// pinned at 25 (the exact opaque-boundary scenario).
const tickArb = fc.record({
  paso_actual: fc.constantFrom("UNIR", "CORTAR_SILENCIOS"),
  estado: fc.constantFrom(
    "en_ejecucion",
    "esperando_edicion_silencios",
  ),
  mensaje: fc.constantFrom("Clips unidos", "Detectando silencios", "Esperando edición"),
});

describe("Task 3.4 — state changes at constant 25% stay monotonic and correlated", () => {
  it("porcentaje stays 25 (monotonic) while state changes, correlation stable", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(tickArb, { minLength: 1, maxLength: 20 }), async (ticks) => {
        const store = createInMemoryStore(makeJob());
        let i = 0;
        const deps = depsWith(store, async () => {
          const t = ticks[Math.min(i, ticks.length - 1)];
          i += 1;
          return { porcentaje: 25, paso_actual: t.paso_actual, mensaje: t.mensaje, error: null, estado: t.estado };
        });

        let prev = 25;
        for (let n = 0; n < ticks.length; n++) {
          const result = await reconcileEditJob("edit-job-1", deps);
          const pct = result!.job.progress.porcentaje;
          // Percentage is monotonic and pinned at the boundary — never the state.
          expect(pct).toBe(25);
          expect(pct).toBeGreaterThanOrEqual(prev);
          prev = pct;
          // Correlation always carries the stable job identity.
          expect(result!.correlation?.editJobId).toBe("edit-job-1");
        }
      }),
      { numRuns: 100 },
    );
  });
});
