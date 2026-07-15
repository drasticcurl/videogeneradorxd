/**
 * Dependency injection helpers for the edit listing route.
 * Extracted from route.ts to avoid invalid Next.js route exports.
 */

import { editJobsDb } from "@/lib/edit/editJobStore";
import type { EditJobStore } from "@/lib/edit/editJobStore";

export interface ListRouteDeps {
  editJobStore: EditJobStore;
}

const defaultDeps: ListRouteDeps = {
  editJobStore: editJobsDb,
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
