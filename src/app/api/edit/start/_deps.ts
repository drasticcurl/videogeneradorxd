/**
 * Dependency injection helpers for the start route.
 * Extracted from route.ts to avoid invalid Next.js route exports.
 */

import { editJobsDb } from "@/lib/edit/editJobStore";
import { createEditorClient } from "@/lib/edit/editorClient";
import { LocalStorageAdapter } from "@/lib/edit/localStorageAdapter";
import { BrollBank } from "@/lib/edit/brollBank";

export interface StartRouteDeps {
  editJobStore: typeof editJobsDb;
  createClient: typeof createEditorClient;
  getStorageAdapter: (projectId: string) => LocalStorageAdapter;
  getBrollBank: () => BrollBank;
}

const defaultDeps: StartRouteDeps = {
  editJobStore: editJobsDb,
  createClient: createEditorClient,
  getStorageAdapter: (projectId: string) => new LocalStorageAdapter(projectId),
  getBrollBank: () => new BrollBank(),
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
