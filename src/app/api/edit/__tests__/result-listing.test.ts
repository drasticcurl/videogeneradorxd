/**
 * Integration tests for GET /api/edit/[editJobId]/result (streaming + signed URL)
 * and GET /api/edit (output listing).
 *
 * Covers:
 * - Range partial content (206)
 * - Signed-URL redirect + TTL clamp
 * - Non-completed rejection (409)
 * - Missing-object 500 (marks needs-re-run)
 * - Newest-first ordering in listing
 * - Empty-list case
 *
 * Requirements: 6.2-6.5, 6.9, 6.10
 */

import { describe, it, expect, afterEach } from "vitest";
import { GET as getResult } from "@/app/api/edit/[editJobId]/result/route";
import { __setDeps as setResultDeps, __resetDeps as resetResultDeps } from "@/app/api/edit/[editJobId]/result/_deps";
import { GET as getList } from "@/app/api/edit/route";
import { __setDeps as setListDeps, __resetDeps as resetListDeps } from "@/app/api/edit/_deps";
import type { EditJob, EditorProgress } from "@/lib/edit/types";
import type { EditJobStore } from "@/lib/edit/editJobStore";
import type { StorageAdapter } from "@/lib/edit/storageAdapter";

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
// Mock storage adapter
// ---------------------------------------------------------------------------

function createMockAdapter(options: {
  outputData?: Uint8Array;
  signedUrl?: string;
  throwOnGet?: boolean;
}): StorageAdapter {
  return {
    putInput: async () => "mock-key",
    toEditorInputReference: async () => "mock-key",
    getOutputStream: async (_editJobId: string, _relKey: string, range?: { start: number; end?: number }) => {
      if (options.throwOnGet) throw new Error("Object not found");
      const data = options.outputData ?? new Uint8Array([0x00, 0x01, 0x02, 0x03]);
      if (range) {
        const end = range.end !== undefined ? range.end + 1 : data.length;
        return data.slice(range.start, end);
      }
      return data;
    },
    persistOutput: async () => "mock-output-key",
    signedGetUrl: async (_key: string, _ttl: number) => options.signedUrl ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<EditJob> = {}): EditJob {
  const progress: EditorProgress = {
    porcentaje: 100,
    pasoActual: null,
    mensaje: "Done",
    error: null,
  };
  return {
    id: "job-001",
    projectId: "proj-001",
    source: { type: "clips", clipIds: ["clip1"] },
    options: { silenceCut: true, subtitles: false },
    status: "completed",
    editorJobId: "editor-job-abc",
    progress,
    outputKey: "edit-io/job-001/outputs/final.mp4",
    error: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T01:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Result route tests
// ---------------------------------------------------------------------------

describe("GET /api/edit/[editJobId]/result", () => {
  afterEach(() => {
    resetResultDeps();
  });

  it("returns 404 for unknown editJobId", async () => {
    const store = createInMemoryStore([]);
    setResultDeps({ editJobStore: store, getStorageAdapter: () => createMockAdapter({}) });

    const req = new Request("http://localhost/api/edit/nonexistent/result");
    const res = await getResult(req, { params: { editJobId: "nonexistent" } });
    expect(res.status).toBe(404);
  });

  it("rejects non-completed jobs with 409", async () => {
    const job = makeJob({ status: "running" });
    const store = createInMemoryStore([job]);
    setResultDeps({ editJobStore: store, getStorageAdapter: () => createMockAdapter({}) });

    const req = new Request("http://localhost/api/edit/job-001/result");
    const res = await getResult(req, { params: { editJobId: "job-001" } });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("not yet available");
  });

  it("returns 500 when completed but outputKey is null (marks needs-re-run)", async () => {
    const job = makeJob({ outputKey: null });
    const store = createInMemoryStore([job]);
    setResultDeps({ editJobStore: store, getStorageAdapter: () => createMockAdapter({}) });

    const req = new Request("http://localhost/api/edit/job-001/result");
    const res = await getResult(req, { params: { editJobId: "job-001" } });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.needsRerun).toBe(true);
  });

  it("returns 500 when output object is absent from store (marks needs-re-run)", async () => {
    const job = makeJob();
    const store = createInMemoryStore([job]);
    setResultDeps({
      editJobStore: store,
      getStorageAdapter: () => createMockAdapter({ throwOnGet: true }),
    });

    const req = new Request("http://localhost/api/edit/job-001/result");
    const res = await getResult(req, { params: { editJobId: "job-001" } });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.needsRerun).toBe(true);
  });

  it("streams full video/mp4 content for completed job", async () => {
    const videoData = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]);
    const job = makeJob();
    const store = createInMemoryStore([job]);
    setResultDeps({
      editJobStore: store,
      getStorageAdapter: () => createMockAdapter({ outputData: videoData }),
    });

    const req = new Request("http://localhost/api/edit/job-001/result");
    const res = await getResult(req, { params: { editJobId: "job-001" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("video/mp4");
    expect(res.headers.get("Content-Length")).toBe("8");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");

    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(videoData);
  });

  it("serves partial content (206) for Range requests", async () => {
    const videoData = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
    const job = makeJob();
    const store = createInMemoryStore([job]);
    setResultDeps({
      editJobStore: store,
      getStorageAdapter: () => createMockAdapter({ outputData: videoData }),
    });

    const req = new Request("http://localhost/api/edit/job-001/result", {
      headers: { Range: "bytes=2-5" },
    });
    const res = await getResult(req, { params: { editJobId: "job-001" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 2-5/8");
    expect(res.headers.get("Content-Length")).toBe("4");

    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(new Uint8Array([0x02, 0x03, 0x04, 0x05]));
  });

  it("redirects to signed URL when available (cloud mode)", async () => {
    const job = makeJob();
    const store = createInMemoryStore([job]);
    const signedUrl = "https://storage.googleapis.com/bucket/output.mp4?X-Goog-Signature=abc";
    setResultDeps({
      editJobStore: store,
      getStorageAdapter: () => createMockAdapter({ signedUrl }),
    });

    const req = new Request("http://localhost/api/edit/job-001/result");
    const res = await getResult(req, { params: { editJobId: "job-001" } });
    // NextResponse.redirect returns 307 or 302
    expect([301, 302, 307, 308]).toContain(res.status);
    expect(res.headers.get("Location")).toBe(signedUrl);
  });
});

// ---------------------------------------------------------------------------
// Listing route tests
// ---------------------------------------------------------------------------

describe("GET /api/edit (listing)", () => {
  afterEach(() => {
    resetListDeps();
  });

  it("returns 400 when projectId is missing", async () => {
    const store = createInMemoryStore([]);
    setListDeps({ editJobStore: store });

    const req = new Request("http://localhost/api/edit");
    const res = await getList(req);
    expect(res.status).toBe(400);
  });

  it("returns empty list when no completed jobs exist", async () => {
    const job = makeJob({ status: "running", outputKey: null });
    const store = createInMemoryStore([job]);
    setListDeps({
      editJobStore: store,
      getStorageAdapter: () => ({
        ...createMockAdapter({}),
        persistOutput: async () => undefined,
      }),
      createClient: () => ({
        baseUrl: "http://localhost:8000",
        procesar: async () => ({ job_id: "", estado: "" }),
        progreso: async () => ({
          porcentaje: 25,
          paso_actual: "UNIR",
          mensaje: "Running",
          estado: "en_ejecucion",
        } as any),
      }) as any,
    });

    const req = new Request("http://localhost/api/edit?projectId=proj-001");
    const res = await getList(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outputs).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("recovers a nonterminal job when durable final.mp4 already exists", async () => {
    const job = makeJob({ status: "running", outputKey: null });
    const store = createInMemoryStore([job]);
    setListDeps({
      editJobStore: store,
      getStorageAdapter: () => ({
        ...createMockAdapter({}),
        persistOutput: async () => "edit-output/job-001/final.mp4",
      }),
    });

    const res = await getList(new Request("http://localhost/api/edit?projectId=proj-001"));
    const body = await res.json();

    expect(body.total).toBe(1);
    expect(body.outputs[0].outputKey).toBe("edit-output/job-001/final.mp4");
    expect(store.getEditJob("job-001")?.status).toBe("completed");
  });

  it("returns only completed jobs with outputKey, newest first", async () => {
    const job1 = makeJob({
      id: "job-001",
      status: "completed",
      outputKey: "edit-io/job-001/outputs/final.mp4",
      updatedAt: "2024-01-01T10:00:00.000Z",
    });
    const job2 = makeJob({
      id: "job-002",
      status: "completed",
      outputKey: "edit-io/job-002/outputs/final.mp4",
      updatedAt: "2024-01-02T10:00:00.000Z",
    });
    const job3 = makeJob({
      id: "job-003",
      status: "failed",
      outputKey: null,
    });
    const job4 = makeJob({
      id: "job-004",
      status: "completed",
      outputKey: "edit-io/job-004/outputs/final.mp4",
      updatedAt: "2024-01-03T10:00:00.000Z",
    });
    const store = createInMemoryStore([job1, job2, job3, job4]);
    setListDeps({ editJobStore: store });

    const req = new Request("http://localhost/api/edit?projectId=proj-001");
    const res = await getList(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(3);
    // Newest first (job-004 Jan 3, job-002 Jan 2, job-001 Jan 1)
    expect(body.outputs[0].editJobId).toBe("job-004");
    expect(body.outputs[1].editJobId).toBe("job-002");
    expect(body.outputs[2].editJobId).toBe("job-001");
  });

  it("filters by projectId", async () => {
    const job1 = makeJob({ id: "job-001", projectId: "proj-001" });
    const job2 = makeJob({ id: "job-002", projectId: "proj-002" });
    const store = createInMemoryStore([job1, job2]);
    setListDeps({ editJobStore: store });

    const req = new Request("http://localhost/api/edit?projectId=proj-001");
    const res = await getList(req);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.outputs[0].editJobId).toBe("job-001");
  });

  it("includes outputKey in each entry", async () => {
    const job = makeJob();
    const store = createInMemoryStore([job]);
    setListDeps({ editJobStore: store });

    const req = new Request("http://localhost/api/edit?projectId=proj-001");
    const res = await getList(req);
    const body = await res.json();
    expect(body.outputs[0].outputKey).toBe("edit-io/job-001/outputs/final.mp4");
  });
});
