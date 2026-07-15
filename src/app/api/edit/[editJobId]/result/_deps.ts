/**
 * Dependency injection helpers for the result route.
 * Extracted from route.ts to avoid invalid Next.js route exports.
 */

import { editJobsDb } from "@/lib/edit/editJobStore";
import { LocalStorageAdapter } from "@/lib/edit/localStorageAdapter";
import type { StorageAdapter } from "@/lib/edit/storageAdapter";
import type { EditJobStore } from "@/lib/edit/editJobStore";

export interface ResultRouteDeps {
  editJobStore: EditJobStore;
  getStorageAdapter: (projectId: string) => StorageAdapter;
}

const defaultDeps: ResultRouteDeps = {
  editJobStore: editJobsDb,
  getStorageAdapter: (projectId: string) => new LocalStorageAdapter(projectId),
};

let currentDeps: ResultRouteDeps = defaultDeps;

export function getDeps(): ResultRouteDeps {
  return currentDeps;
}

export function __setDeps(deps: Partial<ResultRouteDeps>): void {
  currentDeps = { ...defaultDeps, ...deps };
}

export function __resetDeps(): void {
  currentDeps = defaultDeps;
}
