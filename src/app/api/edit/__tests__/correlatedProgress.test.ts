/**
 * Task 3.4 — End-to-end correlated events (Property 1), progress route side.
 *
 * **Validates: Requirements 2.1, 2.2, 2.5**
 *
 * The GET /api/edit/[editJobId]/progress route surfaces the correlation tuple so
 * the tolerant `parseProgressResponse` (Task 3.2) can attach version/revision/
 * editorJobId to the live log — even while the percentage stays at 25%. Video
 * content is never emitted.
 */

import { describe, it, expect, afterEach } from "vitest";
import { GET } from "@/app/api/edit/[editJobId]/progress/route";
import {
  __setDeps as setProgressDeps,
  __resetDeps as resetProgressDeps,
} from "@/app/api/edit/[editJobId]/progress/_deps";
import { parseProgressResponse } from "@/components/edit/editUiData";
import type { EditJob } from "@/lib/edit/types";
import type { EditJobStore } from "@/lib/edit/editJobStore";

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

function fakeClient(progreso: () => Promise<any>): any {
  return { baseUrl: "http://localhost:8000", progreso };
}

function makeJob(overrides: Partial<EditJob> = {}): EditJob {
  return {
    id: "job-001",
    projectId: "proj-001",
    source: { type: "clips", clipIds: ["clip1"] },
    options: { silenceCut: true, subtitles: false },
    status: "running",
    editorJobId: "editor-job-abc",
    progress: { porcentaje: 25, pasoActual: "CORTAR_SILENCIOS", mensaje: "", error: null },
    outputKey: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRequest(): Request {
  return new Request("http://localhost/api/edit/job-001/progress", { method: "GET" });
}

describe("GET /api/edit/[editJobId]/progress — correlation (Task 3.4)", () => {
  afterEach(() => resetProgressDeps());

  it("emits a correlation tuple that parseProgressResponse can surface", async () => {
    const store = createInMemoryStore([makeJob()]);
    setProgressDeps({
      editJobStore: store,
      createClient: () =>
        fakeClient(async () => ({
          porcentaje: 25,
          paso_actual: "CORTAR_SILENCIOS",
          mensaje: "Esperando edición manual de silencios",
          error: null,
          estado: "esperando_edicion_silencios",
        })),
      getStorageAdapter: () =>
        ({
          persistOutput: async () => undefined,
          signedGetUrl: async () => undefined,
          getOutputStream: async () => new Uint8Array(),
          putInput: async () => "",
          toEditorInputReference: async () => "",
        }) as any,
    });

    const res = await GET(makeRequest(), { params: { editJobId: "job-001" } });
    expect(res.status).toBe(200);
    const body = await res.json();

    // Structured correlation object present and carries the job pair.
    expect(body.correlation).toBeDefined();
    expect(body.correlation.editJobId).toBe("job-001");
    expect(body.correlation.editorJobId).toBe("editor-job-abc");
    // Percentage is not the state: the pause is surfaced via status, pct stays 25.
    expect(body.status).toBe("awaiting_silences");
    expect(body.progress.porcentaje).toBe(25);

    // The tolerant Task 3.2 parser picks up the correlation from the response.
    const view = parseProgressResponse(body);
    expect(view.correlation?.editJobId).toBe("job-001");
    expect(view.correlation?.editorJobId).toBe("editor-job-abc");
  });

  it("never emits video content in the progress response", async () => {
    const store = createInMemoryStore([makeJob()]);
    setProgressDeps({
      editJobStore: store,
      createClient: () =>
        fakeClient(async () => ({
          porcentaje: 25,
          paso_actual: "UNIR",
          mensaje: "Uniendo",
          error: null,
          estado: "en_ejecucion",
          video_url: "http://loopback/internal/video.mp4",
        })),
    });
    const res = await GET(makeRequest(), { params: { editJobId: "job-001" } });
    const body = await res.text();
    expect(body).not.toContain("video");
    expect(body).not.toContain("loopback");
  });
});
