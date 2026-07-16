/**
 * Unit tests for the subtitles BFF pass-through route.
 *
 * Requirements: 2.2, 2.3, 2.4, 2.5, 2.6, 8.3
 */

import { describe, it, expect, afterEach } from "vitest";
import { GET, POST } from "../route";
import { __setDeps, __resetDeps } from "../_deps";
import { EditorPermanentError, EditorTransientError } from "@/lib/edit/retry";
import type { EditJob } from "@/lib/edit/types";
import type { EditJobStore } from "@/lib/edit/editJobStore";

function createStore(job?: EditJob): EditJobStore {
  const jobs = new Map<string, EditJob>();
  if (job) jobs.set(job.id, job);
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

function makeJob(overrides: Partial<EditJob> = {}): EditJob {
  return {
    id: "job-1",
    projectId: "proj-1",
    source: { type: "clips", clipIds: ["c1"] },
    options: { silenceCut: true, subtitles: true },
    status: "awaiting_subtitles",
    editorJobId: "editor-1",
    progress: { porcentaje: 70, pasoActual: "SUBTITULOS", mensaje: "", error: null },
    outputKey: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const subPayload = {
  job_id: "editor-1",
  estado: "esperando_revision",
  editable: true,
  grupos: [
    { texto: "hola", inicio_s: 0, fin_s: 1, palabras: null },
    { texto: "mundo", inicio_s: 1, fin_s: 2, palabras: null },
  ],
};

function client(overrides: Record<string, unknown> = {}): any {
  return {
    baseUrl: "http://127.0.0.1:8000",
    getSubtitulos: async () => subPayload,
    postSubtitulos: async () => {},
    ...overrides,
  };
}

const req = (body?: unknown) =>
  new Request("http://localhost/api/edit/job-1/subtitles", {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

afterEach(() => __resetDeps());

describe("GET /subtitles", () => {
  it("returns normalized SubtitlesView with read-only timings", async () => {
    __setDeps({ editJobStore: createStore(makeJob()), createClient: () => client() });
    const res = await GET(new Request("http://localhost"), { params: { editJobId: "job-1" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("awaiting_subtitles");
    expect(body.groups).toEqual([
      { texto: "hola", inicioS: 0, finS: 1 },
      { texto: "mundo", inicioS: 1, finS: 2 },
    ]);
  });

  it("404 unknown / 409 null editorJobId", async () => {
    __setDeps({ editJobStore: createStore(), createClient: () => client() });
    expect((await GET(new Request("http://localhost"), { params: { editJobId: "nope" } })).status).toBe(404);
    __setDeps({ editJobStore: createStore(makeJob({ editorJobId: null })), createClient: () => client() });
    expect((await GET(new Request("http://localhost"), { params: { editJobId: "job-1" } })).status).toBe(409);
  });
});

describe("POST /subtitles", () => {
  it("409 status mismatch", async () => {
    __setDeps({ editJobStore: createStore(makeJob({ status: "running" })), createClient: () => client() });
    expect((await POST(req({ groups: [] }), { params: { editJobId: "job-1" } })).status).toBe(409);
  });

  it("400 on empty-after-trim text with indices", async () => {
    __setDeps({ editJobStore: createStore(makeJob()), createClient: () => client() });
    const res = await POST(req({ groups: [{ texto: "ok" }, { texto: "   " }] }), {
      params: { editJobId: "job-1" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.indices).toEqual([1]);
    expect(body.status).toBe("awaiting_subtitles");
  });

  it("202 running and forwards text-only groups (no timings)", async () => {
    const store = createStore(makeJob());
    let forwarded: any;
    __setDeps({
      editJobStore: store,
      createClient: () =>
        client({
          postSubtitulos: async (_id: string, b: unknown) => {
            forwarded = b;
          },
        }),
    });
    const res = await POST(req({ groups: [{ texto: " hola " }, { texto: "mundo" }] }), {
      params: { editJobId: "job-1" },
    });
    expect(res.status).toBe(202);
    expect(forwarded).toEqual({ grupos: [{ texto: "hola" }, { texto: "mundo" }] });
    expect(JSON.stringify(forwarded)).not.toContain("inicio_s");
    expect(store.getEditJob("job-1")?.status).toBe("running");
  });

  it("editor-4xx (count mismatch) keeps awaiting (400)", async () => {
    const store = createStore(makeJob());
    __setDeps({
      editJobStore: store,
      createClient: () =>
        client({
          postSubtitulos: async () => {
            throw new EditorPermanentError("count mismatch", 400, "mismatch");
          },
        }),
    });
    const res = await POST(req({ groups: [{ texto: "hola" }] }), { params: { editJobId: "job-1" } });
    expect(res.status).toBe(400);
    expect(store.getEditJob("job-1")?.status).toBe("awaiting_subtitles");
  });

  it("editor-404 → recoverableLost, transient → 502", async () => {
    const store = createStore(makeJob());
    __setDeps({
      editJobStore: store,
      createClient: () =>
        client({
          postSubtitulos: async () => {
            throw new EditorPermanentError("gone", 404);
          },
        }),
      getStorageAdapter: () => ({ persistOutput: async () => undefined }) as any,
    });
    expect((await POST(req({ groups: [{ texto: "hola" }] }), { params: { editJobId: "job-1" } })).status).toBe(409);

    const store2 = createStore(makeJob());
    __setDeps({
      editJobStore: store2,
      createClient: () =>
        client({
          postSubtitulos: async () => {
            throw new EditorTransientError("down");
          },
        }),
    });
    const res = await POST(req({ groups: [{ texto: "hola" }] }), { params: { editJobId: "job-1" } });
    expect(res.status).toBe(502);
    expect(store2.getEditJob("job-1")?.status).toBe("awaiting_subtitles");
  });
});
