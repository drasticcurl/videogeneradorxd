/**
 * Property-based test: Preview confinement.
 *
 * **Property 7: Preview confinement**
 * **Validates: Requirements 8.6, 4.1**
 *
 * For arbitrary `name` strings, the proxy only proceeds (reaches the editor)
 * for allowlisted names with no separators or "..". Every other name is
 * rejected with 400 and the editor is never contacted.
 *
 * Uses fast-check for property-based testing.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fc from "fast-check";
import { GET } from "../route";
import { __setDeps, __resetDeps } from "../_deps";
import type { EditJob } from "@/lib/edit/types";
import type { EditJobStore } from "@/lib/edit/editJobStore";

const ALLOWLIST = new Set(["unido.mp4", "cortado.mp4"]);

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
    status: "awaiting_silences",
    editorJobId: "editor-1",
    progress: { porcentaje: 25, pasoActual: null, mensaje: "", error: null },
    outputKey: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

afterEach(() => __resetDeps());

describe("Property 7 — Preview confinement", () => {
  it("only allowlisted, separator-free names reach the editor; else 400", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constantFrom("unido.mp4", "cortado.mp4", "final.mp4", "..", "../x", "a/b"),
          fc.string(),
          fc.string().map((s) => `${s}/../unido.mp4`),
        ),
        async (name) => {
          let editorCalled = false;
          __setDeps({
            editJobStore: createStore(makeJob()),
            createClient: () =>
              ({
                baseUrl: "http://127.0.0.1:8000",
                fetchWorkfile: async () => {
                  editorCalled = true;
                  return new Response(new Uint8Array([1]), {
                    status: 200,
                    headers: { "Content-Type": "video/mp4" },
                  });
                },
              }) as any,
          });

          const decoded = (() => {
            try {
              return decodeURIComponent(name);
            } catch {
              return name;
            }
          })();
          const shouldProceed =
            ALLOWLIST.has(decoded) &&
            !decoded.includes("/") &&
            !decoded.includes("\\") &&
            !decoded.includes("..");

          const res = await GET(new Request("http://localhost/p"), {
            params: { editJobId: "job-1", name },
          });

          if (shouldProceed) {
            expect(editorCalled).toBe(true);
            expect(res.status).toBe(200);
          } else {
            expect(editorCalled).toBe(false);
            expect(res.status).toBe(400);
          }
          __resetDeps();
        },
      ),
      { numRuns: 300 },
    );
  });
});
