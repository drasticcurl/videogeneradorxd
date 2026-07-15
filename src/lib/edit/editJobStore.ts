/**
 * EditJob persistence store — CRUD backed by a separate JSON file.
 *
 * IMPORTANT: Edit jobs are stored in a SEPARATE file (edit-jobs.json) from
 * the generation job store (db.json). This guarantees that edit job failures,
 * writes, or corruption can never affect generation JobRecords, PlanJSON, or
 * the manifest (Requirement 8.4 — isolation of failures).
 *
 * Persistence uses atomic tmp+rename with a fallback for mounted filesystems
 * (Cloud Storage FUSE). Writes retry up to 5 times with exponential backoff
 * (1s → cap 30s) preserving the last successfully persisted state on failure
 * (Requirements 8, 11.6).
 *
 * Requirements: 8, 11
 */

import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import type { EditJob } from "./types";
import { withRetry, EditorTransientError } from "./retry";

// ---------------------------------------------------------------------------
// Store shape — keyed by editJobId
// ---------------------------------------------------------------------------

interface EditJobDbShape {
  editJobs: Record<string, EditJob>;
}

// ---------------------------------------------------------------------------
// File path — separate from the generation db.json
// ---------------------------------------------------------------------------

const EDIT_JOBS_FILE = path.join(config.storage.dataDir, "edit-jobs.json");

// ---------------------------------------------------------------------------
// Load / persist helpers
// ---------------------------------------------------------------------------

function emptyStore(): EditJobDbShape {
  return { editJobs: {} };
}

function loadFromDisk(): EditJobDbShape {
  try {
    fs.mkdirSync(config.storage.dataDir, { recursive: true });
    if (!fs.existsSync(EDIT_JOBS_FILE)) {
      return emptyStore();
    }
    const raw = fs.readFileSync(EDIT_JOBS_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<EditJobDbShape>;
    return {
      editJobs: parsed.editJobs ?? {},
    };
  } catch {
    console.error("[editJobStore] Could not read edit-jobs.json, starting empty.");
    return emptyStore();
  }
}

/**
 * Persists the store to disk using atomic tmp+rename, with a fallback
 * for mounted filesystems where rename may not be available.
 *
 * Throws EditorTransientError on failure so the retry wrapper can handle it.
 */
function persistToDisk(store: EditJobDbShape): void {
  const data = JSON.stringify(store, null, 2);
  const tmp = `${EDIT_JOBS_FILE}.tmp`;

  fs.mkdirSync(config.storage.dataDir, { recursive: true });

  try {
    // Atomic write: tmp + rename
    fs.writeFileSync(tmp, data, "utf8");
    fs.renameSync(tmp, EDIT_JOBS_FILE);
  } catch {
    // Fallback for mounted filesystems (e.g. Cloud Storage FUSE)
    try {
      fs.writeFileSync(EDIT_JOBS_FILE, data, "utf8");
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* tmp may not exist */
      }
    } catch (err2) {
      throw new EditorTransientError(
        `[editJobStore] Failed to persist edit-jobs.json: ${String(err2)}`,
        err2
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Retry-wrapped persistence
// ---------------------------------------------------------------------------

/**
 * Retry persistence options: 5 attempts, exponential backoff 1s → cap 30s.
 * On failure, the in-memory state is preserved (last-good state) and only the
 * disk write is retried.
 */
const PERSIST_RETRY_OPTIONS = {
  maxAttempts: 5,
  initialDelayMs: 1000,
  multiplier: 2,
  maxDelayMs: 30_000,
  // Use a no-op sleep in test environments to avoid slow tests.
  // In production, the default real setTimeout in withRetry applies.
  ...(process.env.NODE_ENV === "test" || process.env.VITEST
    ? { sleep: async () => {} }
    : {}),
} as const;

/**
 * Persist with retry. Returns true if disk write succeeded, false if all
 * attempts were exhausted (in-memory state is preserved regardless).
 */
async function persistWithRetry(store: EditJobDbShape): Promise<boolean> {
  try {
    await withRetry(
      async () => {
        persistToDisk(store);
      },
      PERSIST_RETRY_OPTIONS
    );
    return true;
  } catch {
    console.error(
      "[editJobStore] All persistence retries exhausted. In-memory state preserved."
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Singleton (survives HMR in dev mode)
// ---------------------------------------------------------------------------

const globalForEditJobs = globalThis as unknown as {
  __editJobStore?: EditJobDbShape;
};

const store: EditJobDbShape =
  globalForEditJobs.__editJobStore ??
  (globalForEditJobs.__editJobStore = loadFromDisk());

// ---------------------------------------------------------------------------
// CRUD API
// ---------------------------------------------------------------------------

export interface EditJobStore {
  createEditJob(job: EditJob): Promise<EditJob>;
  getEditJob(id: string): EditJob | undefined;
  updateEditJob(id: string, patch: Partial<EditJob>): Promise<EditJob | undefined>;
  listEditJobs(projectId: string): EditJob[];
}

/**
 * Creates a new EditJob in the store.
 * Persists with retry. If persistence fails, the job remains in memory.
 */
async function createEditJob(job: EditJob): Promise<EditJob> {
  store.editJobs[job.id] = job;
  await persistWithRetry(store);
  return job;
}

/**
 * Gets an EditJob by id. Pure in-memory lookup (no I/O).
 */
function getEditJob(id: string): EditJob | undefined {
  return store.editJobs[id];
}

/**
 * Updates an existing EditJob with a partial patch.
 * Persists with retry. If persistence fails, the in-memory state reflects
 * the update (last-good on-disk state is preserved until next successful write).
 */
async function updateEditJob(
  id: string,
  patch: Partial<EditJob>
): Promise<EditJob | undefined> {
  const existing = store.editJobs[id];
  if (!existing) return undefined;

  const updated: EditJob = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  store.editJobs[id] = updated;
  await persistWithRetry(store);
  return updated;
}

/**
 * Lists all EditJobs that belong to the given projectId, ordered by
 * createdAt descending (most recent first).
 */
function listEditJobs(projectId: string): EditJob[] {
  return Object.values(store.editJobs)
    .filter((job) => job.projectId === projectId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ---------------------------------------------------------------------------
// Exported store instance
// ---------------------------------------------------------------------------

export const editJobsDb: EditJobStore = {
  createEditJob,
  getEditJob,
  updateEditJob,
  listEditJobs,
};

// ---------------------------------------------------------------------------
// Test helpers (not for production use)
// ---------------------------------------------------------------------------

/**
 * Resets the in-memory store and removes the file on disk.
 * Used only in tests.
 */
export function __resetEditJobStore(): void {
  for (const key of Object.keys(store.editJobs)) {
    delete store.editJobs[key];
  }
  try {
    if (fs.existsSync(EDIT_JOBS_FILE)) {
      fs.unlinkSync(EDIT_JOBS_FILE);
    }
  } catch {
    /* ignore */
  }
}

/**
 * Returns the raw in-memory store (for assertions in tests).
 */
export function __getInMemoryStore(): EditJobDbShape {
  return store;
}

/**
 * Directly invokes persistToDisk (for testing the retry behavior).
 */
export function __persistToDiskDirect(storeData: EditJobDbShape): void {
  persistToDisk(storeData);
}

/**
 * Returns the file path for the edit jobs store.
 */
export function __getEditJobsFilePath(): string {
  return EDIT_JOBS_FILE;
}
