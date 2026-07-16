/**
 * Dependency injection helpers for the preview proxy route.
 * Extracted from route.ts to avoid invalid Next.js route exports.
 */

import { editJobsDb } from "@/lib/edit/editJobStore";
import { createEditorClient } from "@/lib/edit/editorClient";
import type { EditJobStore } from "@/lib/edit/editJobStore";
import type { EditorClient } from "@/lib/edit/editorClient";

export interface PreviewRouteDeps {
  editJobStore: EditJobStore;
  createClient: () => EditorClient;
}

const defaultDeps: PreviewRouteDeps = {
  editJobStore: editJobsDb,
  createClient: () => createEditorClient({ timeoutMs: 30_000, retry: { maxAttempts: 1 } }),
};

let currentDeps: PreviewRouteDeps = defaultDeps;

export function getDeps(): PreviewRouteDeps {
  return currentDeps;
}

export function __setDeps(deps: Partial<PreviewRouteDeps>): void {
  currentDeps = { ...defaultDeps, ...deps };
}

export function __resetDeps(): void {
  currentDeps = defaultDeps;
}
