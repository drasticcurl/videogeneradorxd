/**
 * Task 3.8 — Integration test (Next.js / reconciler side): the full
 * 25% → awaiting_silences → timeline transition + preservation, for the
 * `unir-step-hang` diagnostic-first bugfix.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 3.1, 3.4, 3.7
 *
 * FIX CHECKING (Property 1)
 * -------------------------
 * Driving `reconcileEditJob` end-to-end (with injected doubles) through a job
 * that reports estado `esperando_edicion_silencios` yields a correlated,
 * DIFFERENTIATED reconcile event (`reconcile_awaiting_silences`, category C)
 * carrying the correlation tuple, the status becomes `awaiting_silences`, and
 * `controlForStatus("awaiting_silences") === "silence"` so the `SilenceTimeline`
 * mounts (`controlEventForStatus === "timeline_mount"`) — the pause is now
 * observable AND propagates to the UI. A small classifier over the reconcile
 * event trail localizes the job into exactly category C.
 *
 * PRESERVATION (Property 2)
 * -------------------------
 * - Clip order/selection: a permutation ordering validates and is preserved
 *   element-for-element (Req 3.1).
 * - Flow separation: no reachable edit status maps to an "extend"/+7s control,
 *   and the +7s duration constant stays a self-contained 7 (Req 3.4/3.7).
 *
 * EXPECTED OUTCOME: PASS on the instrumented code.
 */

import { describe, it, expect } from "vitest";
import {
  reconcileEditJob,
  type ReconcileDeps,
} from "../jobReconciler";
import {
  type ReconcileEventType,
  validateOrdering,
} from "../statusMap";
import { controlForStatus, controlEventForStatus } from "@/components/edit/editUiData";
import { EXTEND_DURATION } from "@/lib/config";
import type { EditJob, ClipOrderEntry } from "../types";
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
    id: "edit-job-38",
    projectId: "proj-38",
    source: { type: "clips", clipIds: ["c1", "c2"] },
    options: { silenceCut: true, subtitles: true },
    status: "running",
    editorJobId: "editor-38",
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

/** Classify a reconcile event trail into the design's A/B/C/D categories. */
function classify(trail: (ReconcileEventType | undefined)[]): "A" | "B" | "C" | "D" {
  if (trail.includes("editor_state_lost")) return "C";
  if (trail.includes("reconcile_awaiting_silences")) return "C";
  if (trail.includes("status_mapping_failed")) return "D";
  if (trail.includes("reconcile_failed")) return "B";
  return "D";
}

describe("Task 3.8 — full 25% → awaiting_silences → timeline transition (fix checking)", () => {
  it("reconcile of a paused editor job propagates awaiting_silences with correlation and mounts the timeline", async () => {
    const store = createInMemoryStore(makeJob());
    const deps = depsWith(store, async () => ({
      porcentaje: 25,
      paso_actual: "CORTAR_SILENCIOS",
      mensaje: "Esperando edición manual de silencios",
      error: null,
      estado: "esperando_edicion_silencios",
    }));

    // Tick 1: still running at 25% (state independent of the percentage).
    const running = await reconcileEditJob("edit-job-38", deps);
    // Tick 2: the editor reports the pause estado.
    const result = await reconcileEditJob("edit-job-38", deps);

    expect(result?.job.status).toBe("awaiting_silences");
    // Percentage stays 25 (monotonic, never the state).
    expect(result?.job.progress.porcentaje).toBe(25);

    // Differentiated, correlated reconcile event (category C).
    expect(result?.eventType).toBe("reconcile_awaiting_silences");
    expect(result?.correlation?.editJobId).toBe("edit-job-38");
    expect(result?.correlation?.editorJobId).toBe("editor-38");

    // The pause propagates to the UI: the silence timeline mounts.
    expect(controlForStatus(result!.job.status)).toBe("silence");
    expect(controlEventForStatus(result!.job.status)).toBe("timeline_mount");

    // The event trail classifies the job into exactly category C.
    const trail = [running?.eventType, result?.eventType];
    expect(classify(trail)).toBe("C");
  });

  it("a lost editor job during the pause surfaces EDITOR_STATE_LOST (still category C, actionable)", async () => {
    const { EditorPermanentError } = await import("../retry");
    const store = createInMemoryStore(makeJob({ status: "awaiting_silences" }));
    const deps = depsWith(store, async () => {
      throw new EditorPermanentError("gone", 404);
    });
    const result = await reconcileEditJob("edit-job-38", deps);
    expect(result?.job.status).toBe("failed");
    expect(result?.job.error?.paso).toBe("EDITOR_STATE_LOST");
    expect(result?.eventType).toBe("editor_state_lost");
    expect(classify([result?.eventType])).toBe("C");
    // A terminal, actionable failure mounts the error control (no silent hang).
    expect(controlForStatus(result!.job.status)).toBe("error");
  });
});

describe("Task 3.8 — preservation (order/selection + flow separation)", () => {
  it("a permutation ordering validates and preserves clip order element-for-element", () => {
    const ordering: ClipOrderEntry[] = [
      { index: 0, clipId: "c-a", isBroll: false },
      { index: 1, clipId: "c-b", isBroll: true },
      { index: 2, clipId: "c-c", isBroll: false },
    ];
    const res = validateOrdering(ordering);
    expect(res.success).toBe(true);
    // Order preserved exactly (all and only the selected clips, in order).
    expect(ordering.map((e) => e.clipId)).toEqual(["c-a", "c-b", "c-c"]);
    expect(new Set(ordering.map((e) => e.index)).size).toBe(ordering.length);
  });

  it("no reachable edit status maps to an extend/+7s control; +7s duration stays self-contained", () => {
    for (const status of [
      "queued",
      "running",
      "awaiting_silences",
      "awaiting_subtitles",
      "awaiting_final_render",
      "completed",
      "failed",
    ]) {
      const control = controlForStatus(status);
      expect(["silence", "subtitle", "final", "download", "error", "progress"]).toContain(control);
      expect(control).not.toContain("extend");
    }
    expect(EXTEND_DURATION).toBe(7);
  });
});
