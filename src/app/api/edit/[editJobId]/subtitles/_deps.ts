/**
 * Dependency injection helpers for the subtitles pass-through route.
 * Extracted from route.ts to avoid invalid Next.js route exports.
 */

import { editJobsDb } from "@/lib/edit/editJobStore";
import { createEditorClient } from "@/lib/edit/editorClient";
import type { EditJobStore } from "@/lib/edit/editJobStore";
import type { EditorClient } from "@/lib/edit/editorClient";
import { createEditStorageAdapter } from "@/lib/edit/storageFactory";
import type { StorageAdapter } from "@/lib/edit/storageAdapter";

export interface SubtitlesRouteDeps {
  editJobStore: EditJobStore;
  createClient: () => EditorClient;
  getStorageAdapter: (projectId: string) => StorageAdapter;
}

const defaultDeps: SubtitlesRouteDeps = {
  editJobStore: editJobsDb,
  createClient: () => createEditorClient({ timeoutMs: 10_000, retry: { maxAttempts: 1 } }),
  getStorageAdapter: createEditStorageAdapter,
};

let currentDeps: SubtitlesRouteDeps = defaultDeps;

export function getDeps(): SubtitlesRouteDeps {
  return currentDeps;
}

export function __setDeps(deps: Partial<SubtitlesRouteDeps>): void {
  currentDeps = { ...defaultDeps, ...deps };
}

export function __resetDeps(): void {
  currentDeps = defaultDeps;
}
