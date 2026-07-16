/**
 * Property-based test: Isolation of failures (P5).
 *
 * Property 5: For any EditJob transition to failed, the PlanJSON, manifest,
 * and all generation JobRecords remain byte-for-byte unchanged.
 *
 * **Validates: Requirements 8.4**
 *
 * Uses fast-check to generate random EditJob failure scenarios and verify isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import fs from "node:fs";
import path from "node:path";
import { config } from "../../config";
import { editJobsDb, __resetEditJobStore, __getEditJobsFilePath } from "../editJobStore";
import { editJobReducer } from "../editJobReducer";
import type { EditJob, EditJobStatus, EditOptions, EditSource } from "../types";
import type { EditJobAction } from "../editJobReducer";

// ---------------------------------------------------------------------------
// Helpers: snapshot generation-side state files
// ---------------------------------------------------------------------------

const DB_JSON_PATH = path.join(config.storage.dataDir, "db.json");

function getGenerationDbSnapshot(): string | null {
  try {
    if (fs.existsSync(DB_JSON_PATH)) {
      return fs.readFileSync(DB_JSON_PATH, "utf8");
    }
    return null;
  } catch {
    return null;
  }
}

function getManifestSnapshots(outputDir: string): Map<string, string> {
  const snapshots = new Map<string, string>();
  try {
    if (!fs.existsSync(outputDir)) return snapshots;
    const entries = fs.readdirSync(outputDir);
    for (const entry of entries) {
      const manifestPath = path.join(outputDir, entry, "manifest.json");
      if (fs.existsSync(manifestPath)) {
        snapshots.set(manifestPath, fs.readFileSync(manifestPath, "utf8"));
      }
    }
  } catch {
    /* output dir may not exist */
  }
  return snapshots;
}

function getPlanJsonSnapshots(outputDir: string): Map<string, string> {
  const snapshots = new Map<string, string>();
  try {
    if (!fs.existsSync(outputDir)) return snapshots;
    const entries = fs.readdirSync(outputDir);
    for (const entry of entries) {
      const planPath = path.join(outputDir, entry, "plan.json");
      if (fs.existsSync(planPath)) {
        snapshots.set(planPath, fs.readFileSync(planPath, "utf8"));
      }
    }
  } catch {
    /* output dir may not exist */
  }
  return snapshots;
}

// ---------------------------------------------------------------------------
// Arbitraries: generate random EditJob and failure scenarios
// ---------------------------------------------------------------------------

const editSourceArb: fc.Arbitrary<EditSource> = fc.oneof(
  fc.record({
    type: fc.constant("clips" as const),
    clipIds: fc.array(fc.uuid(), { minLength: 1, maxLength: 10 }),
  }),
  fc.record({
    type: fc.constant("final" as const),
    artifactKey: fc.string({ minLength: 1, maxLength: 50 }),
  })
);

const editOptionsArb: fc.Arbitrary<EditOptions> = fc.record({
  silenceCut: fc.boolean(),
  subtitles: fc.boolean(),
  musicTrackId: fc.option(fc.uuid(), { nil: undefined }),
  ordering: fc.constant(undefined),
});

const preFailureStatusArb: fc.Arbitrary<EditJobStatus> = fc.constantFrom(
  "queued",
  "uploading",
  "running",
  "awaiting_silences",
  "awaiting_subtitles",
  "awaiting_final_render"
);

const editJobArb: fc.Arbitrary<EditJob> = fc.record({
  id: fc.uuid(),
  projectId: fc.uuid(),
  source: editSourceArb,
  options: editOptionsArb,
  status: preFailureStatusArb,
  editorJobId: fc.option(fc.uuid(), { nil: null }),
  progress: fc.record({
    porcentaje: fc.integer({ min: 0, max: 100 }),
    pasoActual: fc.option(
      fc.constantFrom("UNIR", "CORTAR_SILENCIOS", "TRANSCRIBIR", "SUBTITULOS", "MUSICA"),
      { nil: null }
    ),
    mensaje: fc.string({ maxLength: 100 }),
    error: fc.constant(null),
  }),
  outputKey: fc.constant(null),
  error: fc.constant(null),
  createdAt: fc.constant(new Date().toISOString()),
  updatedAt: fc.constant(new Date().toISOString()),
});

const failureErrorArb = fc.record({
  paso: fc.constantFrom("UNIR", "CORTAR_SILENCIOS", "TRANSCRIBIR", "SUBTITULOS", "MUSICA", "UPLOAD", "PERSISTENCE"),
  motivo: fc.string({ minLength: 1, maxLength: 200 }),
});

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  __resetEditJobStore();
});

afterEach(() => {
  __resetEditJobStore();
});

// ---------------------------------------------------------------------------
// Property test
// ---------------------------------------------------------------------------

describe("EditJob Store — Property: Isolation of Failures (P5)", () => {
  it("a failed EditJob never mutates generation db.json, manifests, or plan JSONs", () => {
    fc.assert(
      fc.property(editJobArb, failureErrorArb, (job, error) => {
        // Snapshot generation-side state BEFORE the failure
        const dbBefore = getGenerationDbSnapshot();
        const manifestsBefore = getManifestSnapshots(config.storage.outputDir);
        const plansBefore = getPlanJsonSnapshots(config.storage.outputDir);

        // Transition the EditJob to failed via reducer
        const failedJob = editJobReducer(job, { type: "FAILED", error });

        // Verify the EditJob itself transitioned to failed
        // (only if the transition is valid from its current status)
        if (failedJob.status === "failed") {
          expect(failedJob.error).toEqual(error);
        }

        // Snapshot generation-side state AFTER the failure
        const dbAfter = getGenerationDbSnapshot();
        const manifestsAfter = getManifestSnapshots(config.storage.outputDir);
        const plansAfter = getPlanJsonSnapshots(config.storage.outputDir);

        // Assert byte-for-byte unchanged
        expect(dbAfter).toBe(dbBefore);

        // Manifests unchanged
        expect(manifestsAfter.size).toBe(manifestsBefore.size);
        for (const [filePath, contentBefore] of manifestsBefore) {
          expect(manifestsAfter.get(filePath)).toBe(contentBefore);
        }

        // Plan JSONs unchanged
        expect(plansAfter.size).toBe(plansBefore.size);
        for (const [filePath, contentBefore] of plansBefore) {
          expect(plansAfter.get(filePath)).toBe(contentBefore);
        }
      }),
      { numRuns: 200, verbose: true }
    );
  });

  it("persisting a failed EditJob to the edit store does not touch db.json", async () => {
    await fc.assert(
      fc.asyncProperty(editJobArb, failureErrorArb, async (job, error) => {
        __resetEditJobStore();

        // Snapshot generation db BEFORE
        const dbBefore = getGenerationDbSnapshot();

        // Create the edit job in the separate store
        await editJobsDb.createEditJob(job);

        // Transition to failed
        const failedJob = editJobReducer(job, { type: "FAILED", error });

        // Persist the failed state in edit store
        if (failedJob.status === "failed") {
          await editJobsDb.updateEditJob(job.id, {
            status: "failed",
            error: failedJob.error,
          });
        }

        // Verify generation db unchanged
        const dbAfter = getGenerationDbSnapshot();
        expect(dbAfter).toBe(dbBefore);

        // Verify the edit job IS in the edit-jobs.json (isolation: separate store)
        const editJobsFile = __getEditJobsFilePath();
        if (fs.existsSync(editJobsFile)) {
          const editContent = JSON.parse(fs.readFileSync(editJobsFile, "utf8"));
          expect(editContent.editJobs[job.id]).toBeDefined();
        }
      }),
      { numRuns: 100 }
    );
  });

  it("multiple failed EditJobs do not accumulate side-effects on generation state", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(editJobArb, { minLength: 2, maxLength: 10 }),
        fc.array(failureErrorArb, { minLength: 2, maxLength: 10 }),
        async (jobs, errors) => {
          __resetEditJobStore();
          const dbBefore = getGenerationDbSnapshot();

          // Create and fail multiple edit jobs
          for (let i = 0; i < Math.min(jobs.length, errors.length); i++) {
            const job = jobs[i];
            const error = errors[i];

            await editJobsDb.createEditJob(job);
            const failedJob = editJobReducer(job, { type: "FAILED", error });
            if (failedJob.status === "failed") {
              await editJobsDb.updateEditJob(job.id, {
                status: "failed",
                error: failedJob.error,
              });
            }
          }

          // Generation state byte-for-byte unchanged
          const dbAfter = getGenerationDbSnapshot();
          expect(dbAfter).toBe(dbBefore);
        }
      ),
      { numRuns: 50 }
    );
  });
});
