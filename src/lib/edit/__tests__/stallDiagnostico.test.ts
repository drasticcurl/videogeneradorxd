/**
 * Task 1.2 — Reproducible bug-condition diagnostic (Property 1), Next.js side:
 * pause propagation and EDITOR_STATE_LOST for the opaque 25% stall
 * (spec `unir-step-hang`, design §"Examples / Category C",
 * §"Exploratory Bug Condition Checking" cases 2–3).
 *
 * Validates: Requirements 1.1, 1.2, 1.3
 *
 * Methodology (bug-condition, order is mandatory)
 * ------------------------------------------------
 * This is an exploratory bug-condition check written BEFORE any instrumentation.
 * It documents, on the CURRENT code, where the `awaiting_silences` pause fails to
 * be made VISIBLE/CLASSIFIABLE end-to-end, and reproduces the lost-editor-job
 * (`EDITOR_STATE_LOST`) propagation. The diagnosability assertion is EXPECTED TO
 * FAIL on the current code (that failure confirms the gap); it is re-run at
 * Task 3.9 and expected to PASS once the correlation tuple is threaded through
 * `reconcileEditJob` / `statusMap` / the progress route (Task 3.4). Do NOT fix
 * production code or this test here.
 *
 * Reproduced counterexamples on the CURRENT code (the documented gap)
 * -------------------------------------------------------------------
 * 1. **Pause reached but not observable (Category C).** When the editor reports
 *    estado `esperando_edicion_silencios`, `mapEditorEstado` correctly yields
 *    `awaiting_silences` and `controlForStatus("awaiting_silences") === "silence"`
 *    (the timeline WOULD mount) — the mapping works *in isolation*. Yet the
 *    reconciled pause carries NO correlation tuple (no `editJobId`/`editorJobId`/
 *    version/revision on the propagated progress), so an observer cannot confirm
 *    *which* job/build reached the pause nor place it into category C from a
 *    correlated event. The pause is thus reached-but-un-correlated: exactly the
 *    "un-propagated pause" symptom the bug describes.
 * 2. **Lost editor job (Category C via EDITOR_STATE_LOST).** When the editor
 *    returns 404 for a paused job (in-memory JobManager dropped on restart) and
 *    no durable final.mp4 exists, the reconciler surfaces
 *    `failed {paso:"EDITOR_STATE_LOST", ...}` with `live:false`. This is
 *    reproduced below and pins the lost-editor propagation path.
 */

import { describe, it, expect } from "vitest";
import { reconcileEditJob, type ReconcileDeps } from "../jobReconciler";
import { mapEditorEstado } from "../statusMap";
import { controlForStatus } from "@/components/edit/editUiData";
import { EditorPermanentError } from "../retry";
import type { EditJob } from "../types";
import type { EditJobStore } from "../editJobStore";

// The correlation-tuple keys that must accompany the propagated pause so it is
// observable/classifiable end-to-end (design "Correlation tuple"; Req 1.5, 2.5).
// This is the post-fix contract threaded through the reconciler by Task 3.4.
const CORRELATION_KEYS = ["editJobId", "editorJobId"] as const;

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

function depsWith(
  store: EditJobStore,
  progresoImpl: () => Promise<any>,
  persistResult?: string,
): ReconcileDeps {
  return {
    editJobStore: store,
    createClient: () => ({ baseUrl: "http://localhost:8000", progreso: progresoImpl } as any),
    getStorageAdapter: adapter(persistResult),
  };
}

/** Reads a `correlation` object off the reconcile result or its job/progress. */
function extractCorrelation(result: any): Record<string, unknown> | null {
  const candidates = [
    result?.correlation,
    result?.job?.correlation,
    result?.job?.progress?.correlation,
    result?.job?.progress?.correlacion,
  ];
  for (const c of candidates) {
    if (c && typeof c === "object") return c as Record<string, unknown>;
  }
  return null;
}

describe("Task 1.2 — pause propagation baseline (correct in isolation)", () => {
  it("maps estado esperando_edicion_silencios → awaiting_silences", () => {
    const mapped = mapEditorEstado("esperando_edicion_silencios");
    expect(mapped.status).toBe("awaiting_silences");
    expect(mapped.error).toBeNull();
  });

  it("awaiting_silences mounts the silence timeline control", () => {
    expect(controlForStatus("awaiting_silences")).toBe("silence");
  });

  it("reconcile of a paused editor job yields status awaiting_silences", async () => {
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
    expect(result?.live).toBe(true);
  });

  it("reproduces EDITOR_STATE_LOST when a paused editor job 404s with no output", async () => {
    const store = createInMemoryStore(makeJob({ status: "awaiting_silences" }));
    const deps = depsWith(store, async () => {
      throw new EditorPermanentError("gone", 404);
    });
    const result = await reconcileEditJob("edit-job-1", deps);
    expect(result?.job.status).toBe("failed");
    expect(result?.job.error?.paso).toBe("EDITOR_STATE_LOST");
    expect(result?.live).toBe(false);
  });
});

describe("Task 1.2 — pause propagation is NOT correlatable (EXPECTED FAIL on current code)", () => {
  it("the reconciled awaiting_silences pause carries the correlation tuple", async () => {
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

    // GAP: today the propagated pause exposes no correlation, so category C
    // ("pause reached but not visible") cannot be confirmed from a correlated
    // event. Task 3.4 threads the correlation tuple through the reconciler.
    const correlation = extractCorrelation(result);
    expect(
      correlation,
      "reconciled pause must carry a correlation tuple so the awaiting_silences " +
        "state is observable end-to-end (category C diagnosability)",
    ).not.toBeNull();
    for (const key of CORRELATION_KEYS) {
      expect(correlation, `correlation must include ${key}`).toHaveProperty(key);
    }
    expect(correlation?.editJobId).toBe("edit-job-1");
    expect(correlation?.editorJobId).toBe("editor-1");
  });
});
