/**
 * Dependency injection helpers for the progress route.
 * Extracted from route.ts to avoid invalid Next.js route exports.
 */

import { editJobsDb } from "@/lib/edit/editJobStore";
import { createEditorClient } from "@/lib/edit/editorClient";
import type { EditJobStore } from "@/lib/edit/editJobStore";
import type { EditorClient } from "@/lib/edit/editorClient";

export interface ProgressRouteDeps {
  editJobStore: EditJobStore;
  createClient: () => EditorClient;
}

const defaultDeps: ProgressRouteDeps = {
  editJobStore: editJobsDb,
  createClient: () => createEditorClient({ timeoutMs: 5_000, retry: { maxAttempts: 1 } }),
};

let currentDeps: ProgressRouteDeps = defaultDeps;

export function getDeps(): ProgressRouteDeps {
  return currentDeps;
}

export function __setDeps(deps: Partial<ProgressRouteDeps>): void {
  currentDeps = { ...defaultDeps, ...deps };
}

export function __resetDeps(): void {
  currentDeps = defaultDeps;
}
