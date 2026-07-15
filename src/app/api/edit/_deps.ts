/**
 * Dependency injection helpers for the edit listing route.
 * Extracted from route.ts to avoid invalid Next.js route exports.
 */

import { editJobsDb } from "@/lib/edit/editJobStore";
import type { EditJobStore } from "@/lib/edit/editJobStore";
import { createEditorClient, type EditorClient } from "@/lib/edit/editorClient";
import { createEditStorageAdapter } from "@/lib/edit/storageFactory";
import type { StorageAdapter } from "@/lib/edit/storageAdapter";

export interface ListRouteDeps {
  editJobStore: EditJobStore;
  createClient: () => EditorClient;
  getStorageAdapter: (projectId: string) => StorageAdapter;
}

const defaultDeps: ListRouteDeps = {
  editJobStore: editJobsDb,
  createClient: () => createEditorClient({ timeoutMs: 5_000, retry: { maxAttempts: 1 } }),
  getStorageAdapter: createEditStorageAdapter,
};

let currentDeps: ListRouteDeps = defaultDeps;

export function getDeps(): ListRouteDeps {
  return currentDeps;
}

export function __setDeps(deps: Partial<ListRouteDeps>): void {
  currentDeps = { ...defaultDeps, ...deps };
}

export function __resetDeps(): void {
  currentDeps = defaultDeps;
}
