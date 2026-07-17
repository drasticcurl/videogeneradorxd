/**
 * Task 3.5 — Unambiguous, correlated substep events (Property 1), Next.js side:
 * reconciliation / state-mapping events (including EDITOR_STATE_LOST) and the UI
 * timeline-mount event (spec `unir-step-hang`, design §"Fix Implementation /
 * Change 4", §"Diagnostic Decision Matrix").
 *
 * Validates: Requirements 2.2, 2.3
 *
 * These pin the additive, differentiated event kinds that let the last confirmed
 * reconciliation/UI event localize a stall into exactly one category:
 *  - a reached-but-un-propagated pause → `reconcile_awaiting_silences` (C),
 *  - a lost editor job → `editor_state_lost` (C via EDITOR_STATE_LOST),
 *  - an unknown estado → `status_mapping_failed`,
 *  - and the timeline actually mounting in the UI → `timeline_mount` (C resolved).
 * Every reconcile result also carries the correlation tuple. No video content
 * is ever surfaced.
 */

import { describe, it, expect } from "vitest";
import {
  reconcileEditJob,
  type ReconcileDeps,
} from "../jobReconciler";
import { reconcileEventForStatus } from "../statusMap";
import { controlEventForStatus } from "@/components/edit/editUiData";
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

describe("Task 3.5 — reconcileEventForStatus (pure, total)", () => {
  it("maps each status to a distinguishable reconcile event kind", () => {
    expect(reconcileEventForStatus("awaiting_silences")).toBe("reconcile_awaiting_silences");
    expect(reconcileEventForStatus("awaiting_subtitles")).toBe("reconcile_awaiting_subtitles");
    expect(reconcileEventForStatus("awaiting_final_render")).toBe("reconcile_awaiting_final_render");
    expect(reconcileEventForStatus("completed")).toBe("reconcile_completed");
    expect(reconcileEventForStatus("running")).toBe("reconcile_progress");
    expect(reconcileEventForStatus("queued")).toBe("reconcile_progress");
  });

  it("distinguishes EDITOR_STATE_LOST and STATUS_MAPPING failures (categories)", () => {
    expect(reconcileEventForStatus("failed", { paso: "EDITOR_STATE_LOST" })).toBe("editor_state_lost");
    expect(reconcileEventForStatus("failed", { paso: "STATUS_MAPPING" })).toBe("status_mapping_failed");
    expect(reconcileEventForStatus("failed", { paso: "UNIR" })).toBe("reconcile_failed");
    expect(reconcileEventForStatus("failed")).toBe("reconcile_failed");
  });
});

describe("Task 3.5 — reconcile results carry a differentiated eventType", () => {
  it("awaiting_silences pause → reconcile_awaiting_silences + correlation", async () => {
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
    expect(result?.eventType).toBe("reconcile_awaiting_silences");
    expect(result?.correlation?.editJobId).toBe("edit-job-1");
    expect(result?.correlation?.editorJobId).toBe("editor-1");
  });

  it("lost editor job (404 while paused) → editor_state_lost", async () => {
    const store = createInMemoryStore(makeJob({ status: "awaiting_silences" }));
    const deps = depsWith(store, async () => {
      throw new EditorPermanentError("gone", 404);
    });
    const result = await reconcileEditJob("edit-job-1", deps);
    expect(result?.job.status).toBe("failed");
    expect(result?.job.error?.paso).toBe("EDITOR_STATE_LOST");
    expect(result?.eventType).toBe("editor_state_lost");
    expect(result?.correlation?.editJobId).toBe("edit-job-1");
  });

  it("unknown editor estado → status_mapping_failed", async () => {
    const store = createInMemoryStore(makeJob());
    const deps = depsWith(store, async () => ({
      porcentaje: 25,
      paso_actual: "CORTAR_SILENCIOS",
      mensaje: "???",
      error: null,
      estado: "estado_inexistente_xyz",
    }));
    const result = await reconcileEditJob("edit-job-1", deps);
    expect(result?.job.status).toBe("failed");
    expect(result?.eventType).toBe("status_mapping_failed");
  });

  it("running tick at 25% → reconcile_progress (state independent of percentage)", async () => {
    const store = createInMemoryStore(makeJob());
    const deps = depsWith(store, async () => ({
      porcentaje: 25,
      paso_actual: "UNIR",
      mensaje: "Uniendo",
      error: null,
      estado: "en_ejecucion",
    }));
    const result = await reconcileEditJob("edit-job-1", deps);
    expect(result?.job.progress.porcentaje).toBe(25);
    expect(result?.eventType).toBe("reconcile_progress");
  });
});

describe("Task 3.5 — controlEventForStatus (UI timeline-mount event)", () => {
  it("awaiting_silences mounts the timeline → timeline_mount", () => {
    expect(controlEventForStatus("awaiting_silences")).toBe("timeline_mount");
  });

  it("maps every reachable status to a distinguishable mount event", () => {
    expect(controlEventForStatus("awaiting_subtitles")).toBe("subtitle_review_mount");
    expect(controlEventForStatus("awaiting_final_render")).toBe("final_render_mount");
    expect(controlEventForStatus("completed")).toBe("download_mount");
    expect(controlEventForStatus("failed")).toBe("error_mount");
    expect(controlEventForStatus("running")).toBe("progress_mount");
    expect(controlEventForStatus("queued")).toBe("progress_mount");
  });
});
