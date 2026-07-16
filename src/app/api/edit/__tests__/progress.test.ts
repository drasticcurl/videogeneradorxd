/**
 * Integration tests for GET /api/edit/[editJobId]/progress.
 *
 * Covers:
 * - Monotonic merge across reads (porcentaje never decreases)
 * - 404 for unknown job
 * - Fallback on editor failure (returns last progress, live=false)
 * - Distinct awaiting_* statuses for each editor pause estado
 * - Unrecognized estado → failed
 *
 * Requirements: 5.1, 5.2, 5.3, 9.1, 9.2, 9.3
 */

import { describe, it, expect, afterEach } from "vitest";
import { GET } from "@/app/api/edit/[editJobId]/progress/route";
import {
  __setDeps as setProgressDeps,
  __resetDeps as resetProgressDeps,
} from "@/app/api/edit/[editJobId]/progress/_deps";
import type { EditJob, EditorProgress } from "@/lib/edit/types";
import type { EditJobStore } from "@/lib/edit/editJobStore";

// ---------------------------------------------------------------------------
// In-memory store helper
// ---------------------------------------------------------------------------

function createInMemoryStore(initial: EditJob[] = []): EditJobStore {
  const jobs = new Map<string, EditJob>();
  for (const job of initial) jobs.set(job.id, job);
  return {
    createEditJob: async (job: EditJob) => {
      jobs.set(job.id, job);
      return job;
    },
    getEditJob: (id: string) => jobs.get(id),
    updateEditJob: async (id: string, patch: Partial<EditJob>) => {
      const existing = jobs.get(id);
      if (!existing) return undefined;
      const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      jobs.set(id, updated);
      return updated;
    },
    listEditJobs: (projectId: string) =>
      Array.from(jobs.values()).filter((j) => j.projectId === projectId),
  };
}

// A minimal client mock; only progreso is exercised by the reconciler.
function fakeClient(overrides: Record<string, unknown> = {}): any {
  return {
    baseUrl: "http://localhost:8000",
    procesar: async () => ({ job_id: "", estado: "" }),
    progreso: async () => ({ porcentaje: 0, pasoActual: null, mensaje: "", error: null }),
    getSilencios: async () => ({}),
    getSubtitulos: async () => ({}),
    getRender: async () => ({}),
    postSilencios: async () => {},
    postSubtitulos: async () => {},
    postRender: async () => {},
    fetchWorkfile: async () => new Response(null, { status: 404 }),
    ...overrides,
  };
}

function makeJob(overrides: Partial<EditJob> = {}): EditJob {
  const progress: EditorProgress = {
    porcentaje: 0,
    pasoActual: null,
    mensaje: "Job started",
    error: null,
  };
  return {
    id: "job-001",
    projectId: "proj-001",
    source: { type: "clips", clipIds: ["clip1"] },
    options: { silenceCut: true, subtitles: false },
    status: "running",
    editorJobId: "editor-job-abc",
    progress,
    outputKey: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRequest(url = "http://localhost/api/edit/job-001/progress"): Request {
  return new Request(url, { method: "GET" });
}

describe("GET /api/edit/[editJobId]/progress", () => {
  afterEach(() => {
    resetProgressDeps();
  });

  it("returns 404 for unknown editJobId", async () => {
    const store = createInMemoryStore([]);
    setProgressDeps({ editJobStore: store, createClient: () => fakeClient() });
    const res = await GET(makeRequest(), { params: { editJobId: "nonexistent" } });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("nonexistent");
  });

  it("reports 0% when no editorJobId assigned", async () => {
    const job = makeJob({ editorJobId: null, status: "queued" });
    const store = createInMemoryStore([job]);
    setProgressDeps({ editJobStore: store, createClient: () => fakeClient() });
    const res = await GET(makeRequest(), { params: { editJobId: "job-001" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.progress.porcentaje).toBe(0);
    expect(body.status).toBe("queued");
  });

  it("applies monotonic max-merge (never decreases porcentaje)", async () => {
    const job = makeJob({ progress: { porcentaje: 50, pasoActual: "UNIR", mensaje: "", error: null } });
    const store = createInMemoryStore([job]);
    setProgressDeps({
      editJobStore: store,
      createClient: () =>
        fakeClient({
          progreso: async () => ({
            porcentaje: 30,
            paso_actual: "CORTAR_SILENCIOS",
            mensaje: "Processing",
            error: null,
            estado: "en_ejecucion",
          }),
        }),
    });
    const res = await GET(makeRequest(), { params: { editJobId: "job-001" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.progress.porcentaje).toBe(50);
  });

  it("increases porcentaje when editor reports higher value", async () => {
    const job = makeJob({ progress: { porcentaje: 30, pasoActual: "UNIR", mensaje: "", error: null } });
    const store = createInMemoryStore([job]);
    setProgressDeps({
      editJobStore: store,
      createClient: () =>
        fakeClient({
          progreso: async () => ({
            porcentaje: 75,
            paso_actual: "TRANSCRIBIR",
            mensaje: "Transcribing",
            error: null,
            estado: "en_ejecucion",
          }),
        }),
    });
    const res = await GET(makeRequest(), { params: { editJobId: "job-001" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.progress.porcentaje).toBe(75);
  });

  it("returns last progress with live=false on editor failure", async () => {
    const job = makeJob({
      progress: { porcentaje: 45, pasoActual: "UNIR", mensaje: "Processing", error: null },
    });
    const store = createInMemoryStore([job]);
    setProgressDeps({
      editJobStore: store,
      createClient: () =>
        fakeClient({
          progreso: async () => {
            throw new Error("Network timeout");
          },
        }),
    });
    const res = await GET(makeRequest(), { params: { editJobId: "job-001" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.live).toBe(false);
    expect(body.progress.porcentaje).toBe(45);
    expect(body.status).toBe("running");
    expect(body.message).toContain("temporarily unavailable");
  });

  it("sets completed when editor reports COMPLETADO", async () => {
    const job = makeJob();
    const store = createInMemoryStore([job]);
    setProgressDeps({
      editJobStore: store,
      createClient: () =>
        fakeClient({
          progreso: async () => ({
            porcentaje: 100,
            paso_actual: null,
            mensaje: "Done",
            error: null,
            estado: "completado",
          }),
        }),
      getStorageAdapter: () =>
        ({
          putInput: async () => "",
          toEditorInputReference: async () => "",
          getOutputStream: async () => new Uint8Array(),
          persistOutput: async () => "edit-output/job-001/final.mp4",
          signedGetUrl: async () => undefined,
        }) as any,
    });
    const res = await GET(makeRequest(), { params: { editJobId: "job-001" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("completed");
    expect(body.progress.porcentaje).toBe(100);
  });

  it("sets failed when editor reports FALLIDO with error details", async () => {
    const job = makeJob();
    const store = createInMemoryStore([job]);
    setProgressDeps({
      editJobStore: store,
      createClient: () =>
        fakeClient({
          progreso: async () => ({
            porcentaje: 60,
            paso_actual: "TRANSCRIBIR",
            mensaje: "Failed during transcription",
            error: { paso: "TRANSCRIBIR", motivo: "Model load failed" },
            estado: "fallido",
          }),
        }),
    });
    const res = await GET(makeRequest(), { params: { editJobId: "job-001" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(body.progress.error?.paso).toBe("TRANSCRIBIR");
    expect(body.progress.error?.motivo).toBe("Model load failed");
  });

  it("maps each editor pause estado to its distinct awaiting_* status", async () => {
    const cases: Array<[string, string]> = [
      ["esperando_edicion_silencios", "awaiting_silences"],
      ["esperando_revision", "awaiting_subtitles"],
      ["esperando_edicion_final", "awaiting_final_render"],
    ];
    for (const [estado, expected] of cases) {
      const job = makeJob();
      const store = createInMemoryStore([job]);
      setProgressDeps({
        editJobStore: store,
        createClient: () =>
          fakeClient({
            progreso: async () => ({
              porcentaje: 40,
              paso_actual: "CORTAR_SILENCIOS",
              mensaje: "Awaiting user action",
              error: null,
              estado,
            }),
          }),
      });
      const res = await GET(makeRequest(), { params: { editJobId: "job-001" } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe(expected);
      resetProgressDeps();
    }
  });

  it("sets failed on unrecognized estado", async () => {
    const job = makeJob();
    const store = createInMemoryStore([job]);
    setProgressDeps({
      editJobStore: store,
      createClient: () =>
        fakeClient({
          progreso: async () => ({
            porcentaje: 50,
            paso_actual: null,
            mensaje: "",
            error: null,
            estado: "UNKNOWN_ESTADO_XYZ",
          }),
        }),
    });
    const res = await GET(makeRequest(), { params: { editJobId: "job-001" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(body.progress.error?.motivo).toContain("Unrecognized");
  });
});
