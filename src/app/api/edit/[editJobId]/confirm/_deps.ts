/**
 * Dependency injection helpers for the confirm route.
 * Extracted from route.ts to avoid invalid Next.js route exports.
 */

import { editJobsDb } from "@/lib/edit/editJobStore";
import { createEditorClient } from "@/lib/edit/editorClient";
import type { EditJobStore } from "@/lib/edit/editJobStore";
import type { EditorClient } from "@/lib/edit/editorClient";

export interface ConfirmRouteDeps {
  editJobStore: EditJobStore;
  createClient: () => EditorClient;
}

const defaultDeps: ConfirmRouteDeps = {
  editJobStore: editJobsDb,
  createClient: () => createEditorClient(),
};

let currentDeps: ConfirmRouteDeps = defaultDeps;

export function getDeps(): ConfirmRouteDeps {
  return currentDeps;
}

export function __setDeps(deps: Partial<ConfirmRouteDeps>): void {
  currentDeps = { ...defaultDeps, ...deps };
}

export function __resetDeps(): void {
  currentDeps = defaultDeps;
}
