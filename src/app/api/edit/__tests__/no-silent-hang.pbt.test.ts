/**
 * Property-based test: No silent hang.
 *
 * **Property 5: No silent hang**
 * **Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5, 6.5**
 *
 * (a) Every reachable generator status yields a defined control: an interactive
 *     control (awaiting_*), a progress bar (queued|uploading|running), a
 *     download (completed), or an error (failed).
 * (b) Any editor-404 while paused/running resolves via recoverableLost to
 *     `completed` (durable output found) or actionable `failed` (409) — never
 *     leaving the job in an awaiting/running state.
 *
 * Uses fast-check for property-based testing.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { controlForStatus, type EditControl } from "@/components/edit/editUiData";
import { recoverableLost } from "@/lib/edit/jobReconciler";
import type { EditJob, EditJobStatus } from "@/lib/edit/types";
import type { EditJobStore } from "@/lib/edit/editJobStore";

const CONTROLS: EditControl[] = ["silence", "subtitle", "final", "download", "error", "progress"];

const ALL_STATUSES: EditJobStatus[] = [
  "queued",
  "uploading",
  "running",
  "awaiting_silences",
  "awaiting_subtitles",
  "awaiting_final_render",
  "completed",
  "failed",
];

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
    progress: { porcentaje: 30, pasoActual: null, mensaje: "", error: null },
    outputKey: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function adapter(persistResult?: string) {
  return () => ({ persistOutput: async () => persistResult }) as any;
}

describe("Property 5 — No silent hang", () => {
  it("every status (known or arbitrary) maps to a defined control", () => {
    fc.assert(
      fc.property(fc.oneof(fc.constantFrom(...ALL_STATUSES), fc.string()), (status) => {
        const control = controlForStatus(status);
        expect(CONTROLS).toContain(control);
      }),
      { numRuns: 400 },
    );
  });

  it("the three awaiting statuses always yield an interactive control", () => {
    for (const s of ["awaiting_silences", "awaiting_subtitles", "awaiting_final_render"] as const) {
      expect(["silence", "subtitle", "final"]).toContain(controlForStatus(s));
    }
  });

  it("editor-404 while paused/running resolves to completed or actionable failed (never awaiting)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<EditJobStatus>(
          "running",
          "awaiting_silences",
          "awaiting_subtitles",
          "awaiting_final_render",
        ),
        fc.boolean(),
        async (status, hasDurable) => {
          const store = createStore(makeJob(status));
          const res = await recoverableLost("job-1", {
            editJobStore: store,
            getStorageAdapter: adapter(hasDurable ? "edit-output/job-1/final.mp4" : undefined),
          });
          const finalStatus = store.getEditJob("job-1")!.status;
          if (hasDurable) {
            expect(res.status).toBe(200);
            expect(finalStatus).toBe("completed");
          } else {
            expect(res.status).toBe(409);
            expect(finalStatus).toBe("failed");
          }
          // Never left in an awaiting/running state.
          expect(["completed", "failed"]).toContain(finalStatus);
        },
      ),
      { numRuns: 200 },
    );
  });
});
