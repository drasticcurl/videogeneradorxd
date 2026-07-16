/**
 * Unit tests for the recoverable-lost reconciler path and recoverableLost().
 *
 * - editor-404 while paused/running + durable output → completed
 * - editor-404 while paused, no output → failed {paso:"EDITOR_STATE_LOST"}
 * - transient error → live:false, status unchanged
 * - recoverableLost(): output → 200 completed; no output → 409 failed
 *
 * Requirements: 6.1, 6.2, 6.3, 6.5, 10.5
 */

import { describe, it, expect } from "vitest";
import { reconcileEditJob, recoverableLost, type ReconcileDeps } from "../jobReconciler";
import { EditorPermanentError, EditorTransientError } from "../retry";
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
    id: "job-1",
    projectId: "proj-1",
    source: { type: "clips", clipIds: ["c1"] },
    options: { silenceCut: true, subtitles: true },
    status: "awaiting_silences",
    editorJobId: "editor-1",
    progress: { porcentaje: 25, pasoActual: "CORTAR_SILENCIOS", mensaje: "", error: null },
    outputKey: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function adapter(persistResult: string | undefined) {
  return () =>
    ({
      persistOutput: async () => persistResult,
      signedGetUrl: async () => undefined,
      getOutputStream: async () => new Uint8Array(),
      putInput: async () => "",
      toEditorInputReference: async () => "",
    }) as any;
}

function depsWith(store: EditJobStore, progresoImpl: () => Promise<any>, persistResult?: string): ReconcileDeps {
  return {
    editJobStore: store,
    createClient: () => ({ baseUrl: "http://localhost:8000", progreso: progresoImpl } as any),
    getStorageAdapter: adapter(persistResult),
  };
}

describe("reconcileEditJob — recoverable-lost path", () => {
  it("editor-404 while paused with durable output → completed", async () => {
    const store = createInMemoryStore(makeJob());
    const deps = depsWith(
      store,
      async () => {
        throw new EditorPermanentError("gone", 404);
      },
      "edit-output/job-1/final.mp4",
    );
    const result = await reconcileEditJob("job-1", deps);
    expect(result!.job.status).toBe("completed");
    expect(result!.job.outputKey).toBe("edit-output/job-1/final.mp4");
  });

  it("editor-404 while paused, no durable output → failed EDITOR_STATE_LOST", async () => {
    const store = createInMemoryStore(makeJob({ status: "awaiting_final_render" }));
    const deps = depsWith(store, async () => {
      throw new EditorPermanentError("gone", 404);
    });
    const result = await reconcileEditJob("job-1", deps);
    expect(result!.job.status).toBe("failed");
    expect(result!.job.error?.paso).toBe("EDITOR_STATE_LOST");
    expect(result!.live).toBe(false);
  });

  it("transient error → live:false with message, status unchanged", async () => {
    const store = createInMemoryStore(makeJob({ status: "running" }));
    const deps = depsWith(store, async () => {
      throw new EditorTransientError("network");
    });
    const result = await reconcileEditJob("job-1", deps);
    expect(result!.live).toBe(false);
    expect(result!.job.status).toBe("running");
    expect(result!.message).toContain("temporarily unavailable");
  });
});

describe("recoverableLost", () => {
  it("returns 200 completed when durable output exists", async () => {
    const store = createInMemoryStore(makeJob());
    const res = await recoverableLost("job-1", {
      editJobStore: store,
      getStorageAdapter: adapter("edit-output/job-1/final.mp4"),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("completed");
    expect(store.getEditJob("job-1")?.status).toBe("completed");
  });

  it("returns 409 failed EDITOR_STATE_LOST when no durable output", async () => {
    const store = createInMemoryStore(makeJob());
    const res = await recoverableLost("job-1", {
      editJobStore: store,
      getStorageAdapter: adapter(undefined),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(body.error.paso).toBe("EDITOR_STATE_LOST");
    expect(store.getEditJob("job-1")?.status).toBe("failed");
  });

  it("returns 404 when the job does not exist", async () => {
    const store = createInMemoryStore(makeJob());
    const res = await recoverableLost("missing", {
      editJobStore: store,
      getStorageAdapter: adapter(undefined),
    });
    expect(res.status).toBe(404);
  });
});
