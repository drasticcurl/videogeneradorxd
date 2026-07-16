/**
 * Unit tests for the silences BFF pass-through route.
 *
 * Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 8.1, 8.2
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

const silPayload = {
  job_id: "editor-1",
  estado: "esperando_edicion_silencios",
  editable: true,
  video_url: "http://127.0.0.1:8000/workfile/editor-1/unido.mp4",
  video_nombre: "unido.mp4",
  duracion_s: 10,
  fps: 30,
  ancho: 1080,
  alto: 1920,
  tramos: [{ inicio_s: 1, fin_s: 2 }],
};

function client(overrides: Record<string, unknown> = {}): any {
  return {
    baseUrl: "http://127.0.0.1:8000",
    getSilencios: async () => silPayload,
    postSilencios: async () => {},
    ...overrides,
  };
}

function adapter(persistResult?: string) {
  return () => ({ persistOutput: async () => persistResult }) as any;
}

const req = (body?: unknown) =>
  new Request("http://localhost/api/edit/job-1/silences", {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

afterEach(() => __resetDeps());

describe("GET /silences", () => {
  it("returns normalized SilencesView with rewritten previewUrl", async () => {
    __setDeps({ editJobStore: createStore(makeJob()), createClient: () => client() });
    const res = await GET(new Request("http://localhost"), { params: { editJobId: "job-1" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("awaiting_silences");
    expect(body.previewUrl).toBe("/api/edit/job-1/preview/unido.mp4");
    expect(body.segments).toEqual([{ inicioS: 1, finS: 2 }]);
  });

  it("404 for unknown job", async () => {
    __setDeps({ editJobStore: createStore(), createClient: () => client() });
    const res = await GET(new Request("http://localhost"), { params: { editJobId: "nope" } });
    expect(res.status).toBe(404);
  });

  it("409 when editorJobId is null", async () => {
    __setDeps({ editJobStore: createStore(makeJob({ editorJobId: null })), createClient: () => client() });
    const res = await GET(new Request("http://localhost"), { params: { editJobId: "job-1" } });
    expect(res.status).toBe(409);
  });

  it("502 on transient editor error", async () => {
    __setDeps({
      editJobStore: createStore(makeJob()),
      createClient: () =>
        client({
          getSilencios: async () => {
            throw new EditorTransientError("down");
          },
        }),
    });
    const res = await GET(new Request("http://localhost"), { params: { editJobId: "job-1" } });
    expect(res.status).toBe(502);
  });
});

describe("POST /silences", () => {
  it("404 unknown job / 409 null editorJobId / 409 status mismatch", async () => {
    __setDeps({ editJobStore: createStore(), createClient: () => client() });
    expect((await POST(req({ segments: [] }), { params: { editJobId: "nope" } })).status).toBe(404);

    __setDeps({ editJobStore: createStore(makeJob({ editorJobId: null })), createClient: () => client() });
    expect((await POST(req({ segments: [] }), { params: { editJobId: "job-1" } })).status).toBe(409);

    __setDeps({ editJobStore: createStore(makeJob({ status: "running" })), createClient: () => client() });
    expect((await POST(req({ segments: [] }), { params: { editJobId: "job-1" } })).status).toBe(409);
  });

  it("400 with per-segment details on invalid segments", async () => {
    __setDeps({ editJobStore: createStore(makeJob()), createClient: () => client() });
    const res = await POST(req({ segments: [{ inicioS: 5, finS: 3 }] }), { params: { editJobId: "job-1" } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.status).toBe("awaiting_silences");
  });

  it("202 running on editor acceptance and forwards 1:1 tramos", async () => {
    const store = createStore(makeJob());
    let forwarded: unknown;
    __setDeps({
      editJobStore: store,
      createClient: () =>
        client({
          postSilencios: async (_id: string, b: unknown) => {
            forwarded = b;
          },
        }),
    });
    const res = await POST(req({ segments: [{ inicioS: 1, finS: 2 }] }), { params: { editJobId: "job-1" } });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe("running");
    expect(forwarded).toEqual({ tramos: [{ inicio_s: 1, fin_s: 2 }] });
    expect(store.getEditJob("job-1")?.status).toBe("running");
  });

  it("editor-4xx keeps awaiting_silences (400)", async () => {
    const store = createStore(makeJob());
    __setDeps({
      editJobStore: store,
      createClient: () =>
        client({
          postSilencios: async () => {
            throw new EditorPermanentError("bad", 400, "nope");
          },
        }),
    });
    const res = await POST(req({ segments: [{ inicioS: 1, finS: 2 }] }), { params: { editJobId: "job-1" } });
    expect(res.status).toBe(400);
    expect(store.getEditJob("job-1")?.status).toBe("awaiting_silences");
  });

  it("editor-404 routes to recoverableLost (409 no output)", async () => {
    const store = createStore(makeJob());
    __setDeps({
      editJobStore: store,
      createClient: () =>
        client({
          postSilencios: async () => {
            throw new EditorPermanentError("gone", 404);
          },
        }),
      getStorageAdapter: adapter(undefined),
    });
    const res = await POST(req({ segments: [{ inicioS: 1, finS: 2 }] }), { params: { editJobId: "job-1" } });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error?.paso ?? body.status).toBeDefined();
    expect(store.getEditJob("job-1")?.status).toBe("failed");
  });

  it("transient on post → 502 keeping awaiting", async () => {
    const store = createStore(makeJob());
    __setDeps({
      editJobStore: store,
      createClient: () =>
        client({
          postSilencios: async () => {
            throw new EditorTransientError("down");
          },
        }),
    });
    const res = await POST(req({ segments: [{ inicioS: 1, finS: 2 }] }), { params: { editJobId: "job-1" } });
    expect(res.status).toBe(502);
    expect(store.getEditJob("job-1")?.status).toBe("awaiting_silences");
  });
});
