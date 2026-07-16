/**
 * Property-based test: Confirmation round-trip advances the job.
 *
 * **Property 2: Confirmation round-trip advances the job**
 * **Validates: Requirements 1.5, 2.5, 3.5**
 *
 * Model-based test over a mock editor: any valid confirmation to
 * /silences|/subtitles|/render that yields editor 202 results in generator
 * status:"running" and the mock editor leaves its awaiting estado.
 *
 * Uses fast-check for property-based testing.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { POST as postSilences } from "@/app/api/edit/[editJobId]/silences/route";
import { __setDeps as setSil, __resetDeps as resetSil } from "@/app/api/edit/[editJobId]/silences/_deps";
import { POST as postSubtitles } from "@/app/api/edit/[editJobId]/subtitles/route";
import { __setDeps as setSub, __resetDeps as resetSub } from "@/app/api/edit/[editJobId]/subtitles/_deps";
import { POST as postRender } from "@/app/api/edit/[editJobId]/render/route";
import { __setDeps as setRen, __resetDeps as resetRen } from "@/app/api/edit/[editJobId]/render/_deps";
import type { EditJob, EditJobStatus } from "@/lib/edit/types";
import type { EditJobStore } from "@/lib/edit/editJobStore";

function createStore(job: EditJob): EditJobStore {
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
    listEditJobs: () => Array.from(jobs.values()),
  };
}

function makeJob(status: EditJobStatus): EditJob {
  return {
    id: "job-1",
    projectId: "proj-1",
    source: { type: "clips", clipIds: ["c1"] },
    options: { silenceCut: true, subtitles: true },
    status,
    editorJobId: "editor-1",
    progress: { porcentaje: 40, pasoActual: null, mensaje: "", error: null },
    outputKey: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// A mock editor that holds an estado and flips it to en_ejecucion when confirmed.
function mockEditor(initialEstado: string) {
  const state = { estado: initialEstado };
  return {
    state,
    client: {
      baseUrl: "http://localhost:8000",
      getSilencios: async () => ({ duracion_s: 100, video_nombre: "unido.mp4", tramos: [] }),
      postSilencios: async () => {
        state.estado = "en_ejecucion";
      },
      postSubtitulos: async () => {
        state.estado = "en_ejecucion";
      },
      postRender: async () => {
        state.estado = "en_ejecucion";
      },
    } as any,
  };
}

const styleObj = {
  fuente: "Arial",
  tamano: 72,
  color: "#fff",
  color_borde: "#000",
  grosor_borde: 5,
  negrita: true,
  pos_vertical_pct: 20,
  pos_horizontal_pct: 50,
};

describe("Property 2 — Confirmation round-trip advances the job", () => {
  it("silences: valid confirmation → running and editor leaves awaiting estado", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .array(fc.record({ gap: fc.integer({ min: 0, max: 3 }), len: fc.integer({ min: 1, max: 4 }) }), {
            maxLength: 5,
          })
          .map((specs) => {
            const segments: { inicioS: number; finS: number }[] = [];
            let cursor = 0;
            for (const { gap, len } of specs) {
              const inicioS = cursor + gap;
              const finS = inicioS + len;
              segments.push({ inicioS, finS });
              cursor = finS;
            }
            return segments;
          }),
        async (segments) => {
          const store = createStore(makeJob("awaiting_silences"));
          const editor = mockEditor("esperando_edicion_silencios");
          setSil({ editJobStore: store, createClient: () => editor.client });
          const res = await postSilences(
            new Request("http://localhost", { method: "POST", body: JSON.stringify({ segments }) }),
            { params: { editJobId: "job-1" } },
          );
          expect(res.status).toBe(202);
          expect((await res.json()).status).toBe("running");
          expect(store.getEditJob("job-1")?.status).toBe("running");
          expect(editor.state.estado).toBe("en_ejecucion");
          resetSil();
        },
      ),
      { numRuns: 150 },
    );
  });

  it("subtitles: valid confirmation → running", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 1 }).map((s) => `x${s}`), { minLength: 1, maxLength: 6 }),
        async (texts) => {
          const store = createStore(makeJob("awaiting_subtitles"));
          const editor = mockEditor("esperando_revision");
          setSub({ editJobStore: store, createClient: () => editor.client });
          const res = await postSubtitles(
            new Request("http://localhost", {
              method: "POST",
              body: JSON.stringify({ groups: texts.map((texto) => ({ texto })) }),
            }),
            { params: { editJobId: "job-1" } },
          );
          expect(res.status).toBe(202);
          expect(store.getEditJob("job-1")?.status).toBe("running");
          expect(editor.state.estado).toBe("en_ejecucion");
          resetSub();
        },
      ),
      { numRuns: 150 },
    );
  });

  it("render: valid confirmation (≤2 extra texts) → running", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string(), { maxLength: 2 }).map((arr) =>
          arr.map((t) => ({ texto: t, inicio_s: 0, fin_s: 1, estilo: styleObj })),
        ),
        async (extraTexts) => {
          const store = createStore(makeJob("awaiting_final_render"));
          const editor = mockEditor("esperando_edicion_final");
          setRen({ editJobStore: store, createClient: () => editor.client });
          const res = await postRender(
            new Request("http://localhost", { method: "POST", body: JSON.stringify({ extraTexts }) }),
            { params: { editJobId: "job-1" } },
          );
          expect(res.status).toBe(202);
          expect(store.getEditJob("job-1")?.status).toBe("running");
          expect(editor.state.estado).toBe("en_ejecucion");
          resetRen();
        },
      ),
      { numRuns: 150 },
    );
  });
});
