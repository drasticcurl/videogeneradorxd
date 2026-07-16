/**
 * Unit tests for the preview proxy route.
 *
 * Requirements: 4.1, 4.2, 4.4, 4.5, 8.6
 */

import { describe, it, expect, afterEach } from "vitest";
import { GET } from "../route";
import { __setDeps, __resetDeps } from "../_deps";
import { EditorTransientError } from "@/lib/edit/retry";
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
    progress: { porcentaje: 25, pasoActual: null, mensaje: "", error: null },
    outputKey: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function client(fetchWorkfile: (...a: any[]) => Promise<Response>): any {
  return { baseUrl: "http://127.0.0.1:8000", fetchWorkfile };
}

const reqWithRange = (range?: string) =>
  new Request("http://localhost/api/edit/job-1/preview/unido.mp4", {
    headers: range ? { Range: range } : {},
  });

afterEach(() => __resetDeps());

describe("GET /preview/[name]", () => {
  it("allowlisted name streams 200 with Cache-Control no-store", async () => {
    __setDeps({
      editJobStore: createStore(makeJob()),
      createClient: () =>
        client(async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { "Content-Type": "video/mp4", "Content-Length": "3", "Accept-Ranges": "bytes" },
          }),
        ),
    });
    const res = await GET(reqWithRange(), { params: { editJobId: "job-1", name: "unido.mp4" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("video/mp4");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects names not in the allowlist (400)", async () => {
    __setDeps({ editJobStore: createStore(makeJob()), createClient: () => client(async () => new Response()) });
    const res = await GET(reqWithRange(), { params: { editJobId: "job-1", name: "final.mp4" } });
    expect(res.status).toBe(400);
  });

  it("rejects traversal / separators (400)", async () => {
    __setDeps({ editJobStore: createStore(makeJob()), createClient: () => client(async () => new Response()) });
    for (const name of ["../unido.mp4", "a/unido.mp4", "..", "unido.mp4/.."]) {
      const res = await GET(reqWithRange(), { params: { editJobId: "job-1", name } });
      expect(res.status).toBe(400);
    }
  });

  it("forwards Range and returns 206 with Content-Range", async () => {
    let seenRange: string | undefined;
    __setDeps({
      editJobStore: createStore(makeJob()),
      createClient: () =>
        client(async (_id: string, _name: string, range?: string) => {
          seenRange = range;
          return new Response(new Uint8Array([1, 2]), {
            status: 206,
            headers: {
              "Content-Type": "video/mp4",
              "Content-Range": "bytes 0-1/3",
              "Content-Length": "2",
              "Accept-Ranges": "bytes",
            },
          });
        }),
    });
    const res = await GET(reqWithRange("bytes=0-1"), { params: { editJobId: "job-1", name: "unido.mp4" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 0-1/3");
    expect(seenRange).toBe("bytes=0-1");
  });

  it("editor 404 → 404", async () => {
    __setDeps({
      editJobStore: createStore(makeJob()),
      createClient: () => client(async () => new Response("no", { status: 404 })),
    });
    const res = await GET(reqWithRange(), { params: { editJobId: "job-1", name: "unido.mp4" } });
    expect(res.status).toBe(404);
  });

  it("transient → 502", async () => {
    __setDeps({
      editJobStore: createStore(makeJob()),
      createClient: () =>
        client(async () => {
          throw new EditorTransientError("down");
        }),
    });
    const res = await GET(reqWithRange(), { params: { editJobId: "job-1", name: "unido.mp4" } });
    expect(res.status).toBe(502);
  });

  it("404 unknown job / 409 null editorJobId", async () => {
    __setDeps({ editJobStore: createStore(), createClient: () => client(async () => new Response()) });
    expect(
      (await GET(reqWithRange(), { params: { editJobId: "nope", name: "unido.mp4" } })).status,
    ).toBe(404);
    __setDeps({
      editJobStore: createStore(makeJob({ editorJobId: null })),
      createClient: () => client(async () => new Response()),
    });
    expect(
      (await GET(reqWithRange(), { params: { editJobId: "job-1", name: "unido.mp4" } })).status,
    ).toBe(409);
  });
});
