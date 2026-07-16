/**
 * Property-based test: Subtitle edit preserves structure.
 *
 * **Property 4: Subtitle edit preserves structure**
 * **Validates: Requirements 2.4, 2.6, 8.3**
 *
 * For arbitrary group lists: accepted IFF count equals the proposed count and
 * every text is non-empty after trim; on success only text is forwarded (no
 * timings). The proposed-count check is enforced by the editor (modeled here as
 * a 400), and the empty-text check by the BFF.
 *
 * Uses fast-check for property-based testing.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fc from "fast-check";
import { POST } from "../route";
import { __setDeps, __resetDeps } from "../_deps";
import { EditorPermanentError } from "@/lib/edit/retry";
import type { EditJob } from "@/lib/edit/types";
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

function makeJob(): EditJob {
  return {
    id: "job-1",
    projectId: "proj-1",
    source: { type: "clips", clipIds: ["c1"] },
    options: { silenceCut: true, subtitles: true },
    status: "awaiting_subtitles",
    editorJobId: "editor-1",
    progress: { porcentaje: 70, pasoActual: null, mensaje: "", error: null },
    outputKey: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

afterEach(() => __resetDeps());

describe("Property 4 — Subtitle edit preserves structure", () => {
  it("accepted iff count matches proposed and all texts non-empty; only text forwarded", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6 }),
        fc.array(fc.string(), { minLength: 0, maxLength: 8 }),
        async (proposedCount, rawTexts) => {
          const store = createStore(makeJob());
          let forwarded: any = null;
          __setDeps({
            editJobStore: store,
            createClient: () =>
              ({
                baseUrl: "http://localhost:8000",
                // The editor rejects a count that differs from the proposal.
                postSubtitulos: async (_id: string, body: { grupos: { texto: string }[] }) => {
                  if (body.grupos.length !== proposedCount) {
                    throw new EditorPermanentError("count mismatch", 400, "mismatch");
                  }
                  forwarded = body;
                },
              }) as any,
          });

          const groups = rawTexts.map((texto) => ({ texto }));
          const res = await POST(
            new Request("http://localhost", { method: "POST", body: JSON.stringify({ groups }) }),
            { params: { editJobId: "job-1" } },
          );

          const allNonEmpty = rawTexts.length > 0 && rawTexts.every((t) => t.trim().length > 0);
          const countMatches = rawTexts.length === proposedCount;
          const shouldAccept = allNonEmpty && countMatches;

          if (shouldAccept) {
            expect(res.status).toBe(202);
            expect(store.getEditJob("job-1")?.status).toBe("running");
            // Only text forwarded — no timing keys.
            expect(forwarded).not.toBeNull();
            for (const g of forwarded.grupos) {
              expect(Object.keys(g)).toEqual(["texto"]);
            }
          } else {
            expect(res.status).toBe(400);
            expect(store.getEditJob("job-1")?.status).toBe("awaiting_subtitles");
          }
          __resetDeps();
        },
      ),
      { numRuns: 250 },
    );
  });
});
