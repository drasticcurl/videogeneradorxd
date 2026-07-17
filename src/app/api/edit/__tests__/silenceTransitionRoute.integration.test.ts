/**
 * Task 3.8 — Integration test (progress-route side): the full
 * 25% → awaiting_silences → timeline transition + preservation, driven through
 * `GET /api/edit/[editJobId]/progress` for the `unir-step-hang` bugfix.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 3.8
 *
 * FIX CHECKING (Property 1)
 * -------------------------
 * A sequence of route polls (running@25% → awaiting_silences@25%) surfaces the
 * correlation tuple end-to-end; `parseProgressResponse` picks it up and
 * `appendProgressLog` produces DISTINCT visible log lines for the substep/status
 * change even though the percentage stays at 25 — so an observer sees the pause
 * being reached and `controlForStatus` mounts the silence timeline (category C
 * resolved). Video content is never emitted.
 *
 * PRESERVATION (Property 2)
 * -------------------------
 * The percentage stays monotonic non-decreasing across the polls (Req 3.8) and
 * the response carries no video content.
 *
 * EXPECTED OUTCOME: PASS on the instrumented code.
 */

import { describe, it, expect, afterEach } from "vitest";
import { GET } from "@/app/api/edit/[editJobId]/progress/route";
import {
  __setDeps as setProgressDeps,
  __resetDeps as resetProgressDeps,
} from "@/app/api/edit/[editJobId]/progress/_deps";
import {
  parseProgressResponse,
  appendProgressLog,
  formatProgressLogLine,
  controlForStatus,
  type ProgressLogEntry,
} from "@/components/edit/editUiData";
import type { EditJob } from "@/lib/edit/types";
import type { EditJobStore } from "@/lib/edit/editJobStore";

function createInMemoryStore(initial: EditJob[] = []): EditJobStore {
  const jobs = new Map<string, EditJob>();
  for (const job of initial) jobs.set(job.id, job);
  return {
    createEditJob: async (job) => {
      jobs.set(job.id, job);
      return job;
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

function fakeClient(progreso: () => Promise<any>): any {
  return { baseUrl: "http://localhost:8000", progreso };
}

function noopAdapter() {
  return () =>
    ({
      persistOutput: async () => undefined,
      signedGetUrl: async () => undefined,
      getOutputStream: async () => new Uint8Array(),
      putInput: async () => "",
      toEditorInputReference: async () => "",
    }) as any;
}

function makeJob(overrides: Partial<EditJob> = {}): EditJob {
  return {
    id: "job-38",
    projectId: "proj-38",
    source: { type: "clips", clipIds: ["c1", "c2"] },
    options: { silenceCut: true, subtitles: true },
    status: "running",
    editorJobId: "editor-job-38",
    progress: { porcentaje: 25, pasoActual: "CORTAR_SILENCIOS", mensaje: "", error: null },
    outputKey: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRequest(): Request {
  return new Request("http://localhost/api/edit/job-38/progress", { method: "GET" });
}

describe("Task 3.8 — progress route drives the full transition (fix checking)", () => {
  afterEach(() => resetProgressDeps());

  it("surfaces correlation and distinct log lines across running@25% → awaiting_silences@25%", async () => {
    const store = createInMemoryStore([makeJob()]);

    // Poll 1: UNIR at 25% (running).
    let estado = "en_ejecucion";
    let paso = "UNIR";
    let mensaje = "Uniendo y normalizando clips a 9:16";
    setProgressDeps({
      editJobStore: store,
      createClient: () =>
        fakeClient(async () => ({
          porcentaje: 25,
          paso_actual: paso,
          mensaje,
          error: null,
          estado,
        })),
      getStorageAdapter: noopAdapter(),
    });

    const res1 = await GET(makeRequest(), { params: { editJobId: "job-38" } });
    const body1 = await res1.json();

    // Poll 2: pause reached (awaiting_silences), still 25%.
    estado = "esperando_edicion_silencios";
    paso = "CORTAR_SILENCIOS";
    mensaje = "Esperando edición manual de silencios";
    const res2 = await GET(makeRequest(), { params: { editJobId: "job-38" } });
    const body2 = await res2.json();

    // The transition is visible via status while the percentage stays 25.
    expect(body1.status).toBe("running");
    expect(body2.status).toBe("awaiting_silences");
    expect(body1.progress.porcentaje).toBe(25);
    expect(body2.progress.porcentaje).toBe(25);

    // Correlation surfaced end-to-end and picked up by the tolerant parser.
    expect(body2.correlation?.editJobId).toBe("job-38");
    expect(body2.correlation?.editorJobId).toBe("editor-job-38");

    const view1 = parseProgressResponse(body1);
    const view2 = parseProgressResponse(body2);
    expect(view2.correlation?.editorJobId).toBe("editor-job-38");

    // The live log appends DISTINCT lines even though the percentage is constant.
    let log: ProgressLogEntry[] = [];
    log = appendProgressLog(log, {
      time: "10:00:00",
      porcentaje: view1.porcentaje,
      pasoActual: view1.pasoActual,
      mensaje: view1.mensaje,
      status: view1.status,
      estado: view1.estado,
      correlation: view1.correlation,
    });
    log = appendProgressLog(log, {
      time: "10:00:02",
      porcentaje: view2.porcentaje,
      pasoActual: view2.pasoActual,
      mensaje: view2.mensaje,
      status: view2.status,
      estado: view2.estado,
      correlation: view2.correlation,
    });
    expect(log.length).toBe(2);
    // Both lines pinned at 25% but describing different states.
    expect(formatProgressLogLine(log[0])).toContain("25%");
    expect(formatProgressLogLine(log[1])).toContain("25%");
    expect(formatProgressLogLine(log[1])).not.toBe(formatProgressLogLine(log[0]));

    // The pause propagates to the UI control: the silence timeline mounts.
    expect(controlForStatus(body2.status)).toBe("silence");
  });

  it("never emits video content across the transition (preservation)", async () => {
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
          video_url: "http://loopback/internal/video.mp4",
        })),
      getStorageAdapter: noopAdapter(),
    });
    const res = await GET(makeRequest(), { params: { editJobId: "job-38" } });
    const text = await res.text();
    expect(text).not.toContain("loopback");
    expect(text).not.toContain(".mp4");
  });

  it("keeps the percentage monotonic non-decreasing across polls (preservation)", async () => {
    const store = createInMemoryStore([makeJob({ progress: { porcentaje: 25, pasoActual: "UNIR", mensaje: "", error: null } })]);
    const percentages = [25, 10, 25]; // editor briefly reports a lower value
    let i = 0;
    setProgressDeps({
      editJobStore: store,
      createClient: () =>
        fakeClient(async () => ({
          porcentaje: percentages[Math.min(i++, percentages.length - 1)],
          paso_actual: "CORTAR_SILENCIOS",
          mensaje: "trabajando",
          error: null,
          estado: "en_ejecucion",
        })),
      getStorageAdapter: noopAdapter(),
    });

    const seen: number[] = [];
    for (let poll = 0; poll < 3; poll++) {
      const res = await GET(makeRequest(), { params: { editJobId: "job-38" } });
      const body = await res.json();
      seen.push(body.progress.porcentaje);
    }
    for (let k = 1; k < seen.length; k++) {
      expect(seen[k]).toBeGreaterThanOrEqual(seen[k - 1]);
    }
  });
});
