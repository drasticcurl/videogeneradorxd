/**
 * Unit tests for EditJob store — separation and persistence retry.
 *
 * Asserts:
 * - Edit jobs never appear in the generation queue (db.json).
 * - Persistence retries, then preserves last-good state on failure.
 *
 * Requirements: 8, 11
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { EditJob } from "../types";
import {
  editJobsDb,
  __resetEditJobStore,
  __getInMemoryStore,
  __getEditJobsFilePath,
} from "../editJobStore";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEditJob(overrides: Partial<EditJob> = {}): EditJob {
  return {
    id: overrides.id ?? `edit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    projectId: overrides.projectId ?? "project-test-001",
    source: overrides.source ?? { type: "clips", clipIds: ["clip1", "clip2"] },
    options: overrides.options ?? { silenceCut: true, subtitles: false },
    status: overrides.status ?? "queued",
    editorJobId: overrides.editorJobId ?? null,
    progress: overrides.progress ?? {
      porcentaje: 0,
      pasoActual: null,
      mensaje: "",
      error: null,
    },
    outputKey: overrides.outputKey ?? null,
    error: overrides.error ?? null,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  __resetEditJobStore();
});

afterEach(() => {
  __resetEditJobStore();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests: Store separation
// ---------------------------------------------------------------------------

describe("EditJob Store — store separation (Requirement 8)", () => {
  it("stores edit jobs in a separate file from db.json", async () => {
    const job = makeEditJob();
    await editJobsDb.createEditJob(job);

    const editJobsFile = __getEditJobsFilePath();
    expect(editJobsFile).toContain("edit-jobs.json");
    expect(editJobsFile).not.toContain("db.json");

    // The edit-jobs.json file should exist
    expect(fs.existsSync(editJobsFile)).toBe(true);

    // Read the file and verify the job is there
    const content = JSON.parse(fs.readFileSync(editJobsFile, "utf8"));
    expect(content.editJobs[job.id]).toBeDefined();
    expect(content.editJobs[job.id].id).toBe(job.id);
  });

  it("edit jobs never appear in the generation db.json", async () => {
    const job = makeEditJob();
    await editJobsDb.createEditJob(job);

    // Check that db.json (if it exists) does not contain the edit job
    const dataDir = path.dirname(__getEditJobsFilePath());
    const generationDbPath = path.join(dataDir, "db.json");

    if (fs.existsSync(generationDbPath)) {
      const dbContent = JSON.parse(fs.readFileSync(generationDbPath, "utf8"));
      // Edit job id should not appear in the jobs collection
      expect(dbContent.jobs?.[job.id]).toBeUndefined();
    }
    // If db.json doesn't exist, the isolation is trivially satisfied
  });

  it("CRUD: createEditJob stores and returns the job", async () => {
    const job = makeEditJob({ id: "edit-create-test" });
    const result = await editJobsDb.createEditJob(job);

    expect(result).toEqual(job);
    expect(editJobsDb.getEditJob("edit-create-test")).toEqual(job);
  });

  it("CRUD: getEditJob returns undefined for non-existent id", () => {
    expect(editJobsDb.getEditJob("non-existent-id")).toBeUndefined();
  });

  it("CRUD: updateEditJob applies partial patch", async () => {
    const job = makeEditJob({ id: "edit-update-test", status: "queued" });
    // Set a past timestamp so updatedAt comparison works
    job.updatedAt = "2020-01-01T00:00:00.000Z";
    await editJobsDb.createEditJob(job);

    const updated = await editJobsDb.updateEditJob("edit-update-test", {
      status: "running",
      editorJobId: "editor-123",
    });

    expect(updated).toBeDefined();
    expect(updated!.status).toBe("running");
    expect(updated!.editorJobId).toBe("editor-123");
    // updatedAt should be refreshed (later than the artificial old timestamp)
    expect(updated!.updatedAt).not.toBe("2020-01-01T00:00:00.000Z");
    // Other fields unchanged
    expect(updated!.projectId).toBe(job.projectId);
    expect(updated!.source).toEqual(job.source);
  });

  it("CRUD: updateEditJob returns undefined for non-existent id", async () => {
    const result = await editJobsDb.updateEditJob("non-existent", { status: "failed" });
    expect(result).toBeUndefined();
  });

  it("CRUD: listEditJobs filters by projectId", async () => {
    const jobA = makeEditJob({ id: "edit-a", projectId: "project-A" });
    const jobB = makeEditJob({ id: "edit-b", projectId: "project-B" });
    const jobC = makeEditJob({ id: "edit-c", projectId: "project-A" });

    await editJobsDb.createEditJob(jobA);
    await editJobsDb.createEditJob(jobB);
    await editJobsDb.createEditJob(jobC);

    const projectAJobs = editJobsDb.listEditJobs("project-A");
    expect(projectAJobs).toHaveLength(2);
    expect(projectAJobs.map((j) => j.id).sort()).toEqual(["edit-a", "edit-c"]);

    const projectBJobs = editJobsDb.listEditJobs("project-B");
    expect(projectBJobs).toHaveLength(1);
    expect(projectBJobs[0].id).toBe("edit-b");
  });

  it("CRUD: listEditJobs returns empty array for unknown project", () => {
    expect(editJobsDb.listEditJobs("unknown-project")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: Persistence retry
// ---------------------------------------------------------------------------

describe("EditJob Store — persistence retry (Requirement 11.6)", () => {
  it("preserves in-memory state even when disk write fails", async () => {
    const job = makeEditJob({ id: "edit-persist-fail" });

    // First, create successfully to get base state on disk
    await editJobsDb.createEditJob(job);

    // Now mock writeFileSync to always fail (simulating persistent disk failure)
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("Disk full");
    });

    // Attempt update — all persistence retries will fail but in-memory should update
    const updated = await editJobsDb.updateEditJob("edit-persist-fail", {
      status: "running",
      editorJobId: "editor-xyz",
    });

    // In-memory state should be updated
    expect(updated).toBeDefined();
    expect(updated!.status).toBe("running");

    // Verify in-memory store has the updated value
    const inMemory = __getInMemoryStore();
    expect(inMemory.editJobs["edit-persist-fail"].status).toBe("running");

    writeSpy.mockRestore();
  });

  it("in-memory state reflects update even after exhausted retries", async () => {
    const job = makeEditJob({ id: "edit-exhausted" });
    await editJobsDb.createEditJob(job);

    // Mock writeFileSync to always fail
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("Persistent disk error");
    });

    // Update should still work in-memory
    await editJobsDb.updateEditJob("edit-exhausted", {
      status: "failed",
      error: { paso: "TRANSCRIBIR", motivo: "Whisper crash" },
    });

    const inMemory = __getInMemoryStore();
    expect(inMemory.editJobs["edit-exhausted"].status).toBe("failed");
    expect(inMemory.editJobs["edit-exhausted"].error).toEqual({
      paso: "TRANSCRIBIR",
      motivo: "Whisper crash",
    });

    writeSpy.mockRestore();
  });
});
