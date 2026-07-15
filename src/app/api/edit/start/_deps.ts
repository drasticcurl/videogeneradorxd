/**
 * Dependency injection helpers for the start route.
 * Extracted from route.ts to avoid invalid Next.js route exports.
 */

import { editJobsDb } from "@/lib/edit/editJobStore";
import { createEditorClient } from "@/lib/edit/editorClient";
import { createEditStorageAdapter } from "@/lib/edit/storageFactory";
import type { StorageAdapter } from "@/lib/edit/storageAdapter";
import { BrollBank } from "@/lib/edit/brollBank";
import { launchEditJobMonitor } from "@/lib/edit/jobReconciler";

export interface StartRouteDeps {
  editJobStore: typeof editJobsDb;
  createClient: typeof createEditorClient;
  getStorageAdapter: (projectId: string) => StorageAdapter;
  getBrollBank: () => BrollBank;
  startMonitor: (editJobId: string) => void;
}

const defaultDeps: StartRouteDeps = {
  editJobStore: editJobsDb,
  createClient: createEditorClient,
  getStorageAdapter: createEditStorageAdapter,
  getBrollBank: () => new BrollBank(),
  startMonitor: launchEditJobMonitor,
};

let currentDeps: StartRouteDeps = defaultDeps;

export function getDeps(): StartRouteDeps {
  return currentDeps;
}

export function __setDeps(deps: Partial<StartRouteDeps>): void {
  currentDeps = { ...defaultDeps, ...deps };
}

export function __resetDeps(): void {
  currentDeps = defaultDeps;
}
