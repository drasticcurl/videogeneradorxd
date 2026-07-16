/**
 * Unit tests for the render BFF pass-through route.
 *
 * Requirements: 3.2, 3.3, 3.4, 3.5, 8.4, 8.5
 */

import { describe, it, expect, afterEach } from "vitest";
import { GET, POST } from "../route";
import { __setDeps, __resetDeps } from "../_deps";
import { EditorPermanentError, EditorTransientError } from "@/lib/edit/retry";
import type { EditJob } from "@/lib/edit/types";
import type { EditJobStore } from "@/lib/edit/editJobStore";
import type { EditorTextoExtra } from "@/lib/edit/editorClient";

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
    status: "awaiting_final_render",
    editorJobId: "editor-1",
    progress: { porcentaje: 85, pasoActual: "SUBTITULOS", mensaje: "", error: null },
    outputKey: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const renderPayload = {
  job_id: "editor-1",
  estado: "esperando_edicion_final",
  editable: true,
  motor_preferido: "remotion",
  grupos: [{ texto: "line", inicio_s: 0, fin_s: 1, palabras: null }],
  video_url: "http://127.0.0.1:8000/workfile/editor-1/cortado.mp4",
  video_nombre: "cortado.mp4",
  fps: 30,
  ancho: 1080,
  alto: 1920,
  duracion_s: null,
  textos_extra: [],
};

function style() {
  return {
    fuente: "Arial",
    tamano: 72,
    color: "#fff",
    color_borde: "#000",
    grosor_borde: 5,
    negrita: true,
    pos_vertical_pct: 80,
    pos_horizontal_pct: 50,
  };
}
function extra(texto: string): EditorTextoExtra {
  return { texto, inicio_s: 0, fin_s: 1, estilo: style() };
}

function client(overrides: Record<string, unknown> = {}): any {
  return {
    baseUrl: "http://127.0.0.1:8000",
    getRender: async () => renderPayload,
    postRender: async () => {},
    ...overrides,
  };
}

const req = (body?: unknown) =>
  new Request("http://localhost/api/edit/job-1/render", {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

afterEach(() => __resetDeps());

describe("GET /render", () => {
  it("returns normalized FinalRenderView with cortado preview", async () => {
    __setDeps({ editJobStore: createStore(makeJob()), createClient: () => client() });
    const res = await GET(new Request("http://localhost"), { params: { editJobId: "job-1" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("awaiting_final_render");
    expect(body.previewUrl).toBe("/api/edit/job-1/preview/cortado.mp4");
  });

  it("404 unknown / 409 null editorJobId", async () => {
    __setDeps({ editJobStore: createStore(), createClient: () => client() });
    expect((await GET(new Request("http://localhost"), { params: { editJobId: "nope" } })).status).toBe(404);
    __setDeps({ editJobStore: createStore(makeJob({ editorJobId: null })), createClient: () => client() });
    expect((await GET(new Request("http://localhost"), { params: { editJobId: "job-1" } })).status).toBe(409);
  });
});

describe("POST /render", () => {
  it("409 status mismatch", async () => {
    __setDeps({ editJobStore: createStore(makeJob({ status: "running" })), createClient: () => client() });
    expect((await POST(req({}), { params: { editJobId: "job-1" } })).status).toBe(409);
  });

  it("400 on more than 2 extra texts", async () => {
    __setDeps({ editJobStore: createStore(makeJob()), createClient: () => client() });
    const res = await POST(req({ extraTexts: [extra("a"), extra("b"), extra("c")] }), {
      params: { editJobId: "job-1" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).status).toBe("awaiting_final_render");
  });

  it("400 on wrong motor", async () => {
    __setDeps({ editJobStore: createStore(makeJob()), createClient: () => client() });
    const res = await POST(req({ extraTexts: [], motor: "ass" }), { params: { editJobId: "job-1" } });
    expect(res.status).toBe(400);
  });

  it("202 running and forwards {textos_extra, motor:'remotion'}", async () => {
    const store = createStore(makeJob());
    let forwarded: any;
    __setDeps({
      editJobStore: store,
      createClient: () =>
        client({
          postRender: async (_id: string, b: unknown) => {
            forwarded = b;
          },
        }),
    });
    const res = await POST(req({ extraTexts: [extra("hook")] }), { params: { editJobId: "job-1" } });
    expect(res.status).toBe(202);
    expect(forwarded.motor).toBe("remotion");
    expect(forwarded.textos_extra).toHaveLength(1);
    expect(store.getEditJob("job-1")?.status).toBe("running");
  });

  it("editor-4xx keeps awaiting (400), editor-404 → recoverable, transient → 502", async () => {
    const store = createStore(makeJob());
    __setDeps({
      editJobStore: store,
      createClient: () =>
        client({
          postRender: async () => {
            throw new EditorPermanentError("bad", 400, "no");
          },
        }),
    });
    expect((await POST(req({ extraTexts: [] }), { params: { editJobId: "job-1" } })).status).toBe(400);
    expect(store.getEditJob("job-1")?.status).toBe("awaiting_final_render");

    const store2 = createStore(makeJob());
    __setDeps({
      editJobStore: store2,
      createClient: () =>
        client({
          postRender: async () => {
            throw new EditorPermanentError("gone", 404);
          },
        }),
      getStorageAdapter: () => ({ persistOutput: async () => undefined }) as any,
    });
    expect((await POST(req({ extraTexts: [] }), { params: { editJobId: "job-1" } })).status).toBe(409);

    const store3 = createStore(makeJob());
    __setDeps({
      editJobStore: store3,
      createClient: () =>
        client({
          postRender: async () => {
            throw new EditorTransientError("down");
          },
        }),
    });
    const res = await POST(req({ extraTexts: [] }), { params: { editJobId: "job-1" } });
    expect(res.status).toBe(502);
    expect(store3.getEditJob("job-1")?.status).toBe("awaiting_final_render");
  });
});
