/**
 * Integration tests for GET /api/edit/[editJobId]/progress and
 * POST /api/edit/[editJobId]/confirm.
 *
 * Covers:
 * - Monotonic merge across reads (porcentaje never decreases)
 * - 404 for unknown job
 * - Fallback on editor failure (returns last progress, live=false)
 * - awaiting_edit → running on confirm
 * - Rejected confirm (stays awaiting_edit)
 * - Auth protection is provided by Next.js middleware (tested separately)
 *
 * Requirements: 5.1-5.12, 9.3
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GET } from "@/app/api/edit/[editJobId]/progress/route";
import { __setDeps as setProgressDeps, __resetDeps as resetProgressDeps } from "@/app/api/edit/[editJobId]/progress/_deps";
import { POST } from "@/app/api/edit/[editJobId]/confirm/route";
import { __setDeps as setConfirmDeps, __resetDeps as resetConfirmDeps } from "@/app/api/edit/[editJobId]/confirm/_deps";
import type { EditJob, EditorProgress } from "@/lib/edit/types";
import type { EditJobStore } from "@/lib/edit/editJobStore";

// ---------------------------------------------------------------------------
// In-memory store helper
// ---------------------------------------------------------------------------

function createInMemoryStore(initial: EditJob[] = []): EditJobStore {
  const jobs = new Map<string, EditJob>();
  for (const job of initial) {
    jobs.set(job.id, job);
  }

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeConfirmRequest(): Request {
  return new Request("http://localhost/api/edit/job-001/confirm", { method: "POST" });
}

// ---------------------------------------------------------------------------
// Progress route tests
// ---------------------------------------------------------------------------

describe("GET /api/edit/[editJobId]/progress", () => {
  afterEach(() => {
    resetProgressDeps();
  });

  it("returns 404 for unknown editJobId", async () => {
    const store = createInMemoryStore([]);
    setProgressDeps({
      editJobStore: store,
      createClient: () => ({ baseUrl: "http://localhost:8000", procesar: async () => ({ job_id: "", estado: "" }), progreso: async () => ({ porcentaje: 0, pasoActual: null, mensaje: "", error: null }) }),
    });

    const res = await GET(makeRequest(), { params: { editJobId: "nonexistent" } });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("nonexistent");
  });

  it("reports 0% when no editorJobId assigned", async () => {
    const job = makeJob({ editorJobId: null, status: "queued" });
    const store = createInMemoryStore([job]);
    setProgressDeps({
      editJobStore: store,
      createClient: () => ({ baseUrl: "http://localhost:8000", procesar: async () => ({ job_id: "", estado: "" }), progreso: async () => ({ porcentaje: 0, pasoActual: null, mensaje: "", error: null }) }),
    });

    const res = await GET(makeRequest(), { params: { editJobId: "job-001" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.progress.porcentaje).toBe(0);
    expect(body.status).toBe("queued");
  });

  it("applies monotonic max-merge (never decreases porcentaje)", async () => {
    const job = makeJob({ progress: { porcentaje: 50, pasoActual: "UNIR", mensaje: "", error: null } });
    const store = createInMemoryStore([job]);

    // Editor reports 30% (less than current 50%)
    setProgressDeps({
      editJobStore: store,
      createClient: () => ({
        baseUrl: "http://localhost:8000",
        procesar: async () => ({ job_id: "", estado: "" }),
        progreso: async () => ({ porcentaje: 30, paso_actual: "CORTAR_SILENCIOS", mensaje: "Processing", error: null, estado: "en_ejecucion" } as any),
      }),
    });

    const res = await GET(makeRequest(), { params: { editJobId: "job-001" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Should remain at 50 (never decrease)
    expect(body.progress.porcentaje).toBe(50);
  });

  it("increases porcentaje when editor reports higher value", async () => {
    const job = makeJob({ progress: { porcentaje: 30, pasoActual: "UNIR", mensaje: "", error: null } });
    const store = createInMemoryStore([job]);

    setProgressDeps({
      editJobStore: store,
      createClient: () => ({
        baseUrl: "http://localhost:8000",
        procesar: async () => ({ job_id: "", estado: "" }),
        progreso: async () => ({ porcentaje: 75, paso_actual: "TRANSCRIBIR", mensaje: "Transcribing", error: null, estado: "en_ejecucion" } as any),
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
      createClient: () => ({
        baseUrl: "http://localhost:8000",
        procesar: async () => ({ job_id: "", estado: "" }),
        progreso: async () => { throw new Error("Network timeout"); },
      }),
    });

    const res = await GET(makeRequest(), { params: { editJobId: "job-001" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.live).toBe(false);
    expect(body.progress.porcentaje).toBe(45);
    expect(body.status).toBe("running"); // preserves current status
    expect(body.message).toContain("temporarily unavailable");
  });

  it("sets completed when editor reports COMPLETADO", async () => {
    const job = makeJob();
    const store = createInMemoryStore([job]);

    setProgressDeps({
      editJobStore: store,
      createClient: () => ({
        baseUrl: "http://localhost:8000",
        procesar: async () => ({ job_id: "", estado: "" }),
        progreso: async () => ({ porcentaje: 100, paso_actual: null, mensaje: "Done", error: null, estado: "completado" } as any),
      }),
      getStorageAdapter: () => ({
        putInput: async () => "",
        toEditorInputReference: async () => "",
        getOutputStream: async () => new Uint8Array(),
        persistOutput: async () => "edit-output/job-001/final.mp4",
        signedGetUrl: async () => undefined,
      }),
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
      createClient: () => ({
        baseUrl: "http://localhost:8000",
        procesar: async () => ({ job_id: "", estado: "" }),
        progreso: async () => ({
          porcentaje: 60,
          paso_actual: "TRANSCRIBIR",
          mensaje: "Failed during transcription",
          error: { paso: "TRANSCRIBIR", motivo: "Model load failed" },
          estado: "fallido",
        } as any),
      }),
    });

    const res = await GET(makeRequest(), { params: { editJobId: "job-001" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(body.progress.error?.paso).toBe("TRANSCRIBIR");
    expect(body.progress.error?.motivo).toBe("Model load failed");
  });

  it("sets awaiting_edit when editor reports awaiting estado", async () => {
    const job = makeJob();
    const store = createInMemoryStore([job]);

    setProgressDeps({
      editJobStore: store,
      createClient: () => ({
        baseUrl: "http://localhost:8000",
        procesar: async () => ({ job_id: "", estado: "" }),
        progreso: async () => ({
          porcentaje: 40,
          paso_actual: "CORTAR_SILENCIOS",
          mensaje: "Awaiting user confirmation",
          error: null,
          estado: "esperando_edicion_silencios",
        } as any),
      }),
    });

    const res = await GET(makeRequest(), { params: { editJobId: "job-001" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("awaiting_edit");
  });

  it("sets failed on unrecognized estado", async () => {
    const job = makeJob();
    const store = createInMemoryStore([job]);

    setProgressDeps({
      editJobStore: store,
      createClient: () => ({
        baseUrl: "http://localhost:8000",
        procesar: async () => ({ job_id: "", estado: "" }),
        progreso: async () => ({
          porcentaje: 50,
          paso_actual: null,
          mensaje: "",
          error: null,
          estado: "UNKNOWN_ESTADO_XYZ",
        } as any),
      }),
    });

    const res = await GET(makeRequest(), { params: { editJobId: "job-001" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(body.progress.error?.motivo).toContain("Unrecognized");
  });
});

// ---------------------------------------------------------------------------
// Confirm route tests
// ---------------------------------------------------------------------------

describe("POST /api/edit/[editJobId]/confirm", () => {
  afterEach(() => {
    resetConfirmDeps();
  });

  it("returns 404 for unknown editJobId", async () => {
    const store = createInMemoryStore([]);
    setConfirmDeps({
      editJobStore: store,
      createClient: () => ({ baseUrl: "http://localhost:8000", procesar: async () => ({ job_id: "", estado: "" }), progreso: async () => ({ porcentaje: 0, pasoActual: null, mensaje: "", error: null }) } as any),
    });

    const res = await POST(makeConfirmRequest(), { params: { editJobId: "nonexistent" } });
    expect(res.status).toBe(404);
  });

  it("returns 409 when job is not in awaiting_edit status", async () => {
    const job = makeJob({ status: "running" });
    const store = createInMemoryStore([job]);
    setConfirmDeps({
      editJobStore: store,
      createClient: () => ({ baseUrl: "http://localhost:8000", procesar: async () => ({ job_id: "", estado: "" }), progreso: async () => ({ porcentaje: 0, pasoActual: null, mensaje: "", error: null }) } as any),
    });

    const res = await POST(makeConfirmRequest(), { params: { editJobId: "job-001" } });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("running");
  });

  it("transitions awaiting_edit → running on successful confirm", async () => {
    const job = makeJob({ status: "awaiting_edit" });
    const store = createInMemoryStore([job]);

    setConfirmDeps({
      editJobStore: store,
      createClient: () => ({
        baseUrl: "http://localhost:8000",
        procesar: async () => ({ job_id: "", estado: "" }),
        progreso: async () => ({ porcentaje: 0, pasoActual: null, mensaje: "", error: null }),
        confirmar: async () => ({ ok: true }),
      } as any),
    });

    const res = await POST(makeConfirmRequest(), { params: { editJobId: "job-001" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("running");

    // Verify store was updated
    const updated = store.getEditJob("job-001");
    expect(updated?.status).toBe("running");
  });

  it("keeps awaiting_edit on rejected confirmation", async () => {
    const job = makeJob({ status: "awaiting_edit" });
    const store = createInMemoryStore([job]);

    const { EditorPermanentError } = await import("@/lib/edit/retry");

    setConfirmDeps({
      editJobStore: store,
      createClient: () => ({
        baseUrl: "http://localhost:8000",
        procesar: async () => ({ job_id: "", estado: "" }),
        progreso: async () => ({ porcentaje: 0, pasoActual: null, mensaje: "", error: null }),
        confirmar: async () => { throw new EditorPermanentError("Rejected by editor", 422, "Not ready"); },
      } as any),
    });

    const res = await POST(makeConfirmRequest(), { params: { editJobId: "job-001" } });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.status).toBe("awaiting_edit");
    expect(body.error).toContain("rejected");

    // Store should still be awaiting_edit
    const current = store.getEditJob("job-001");
    expect(current?.status).toBe("awaiting_edit");
  });
});
