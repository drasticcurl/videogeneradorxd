/**
 * GET /api/edit — List completed edit jobs for a project.
 *
 * Returns only completed EditJobs, each with its retrievable output key,
 * ordered by completion time from newest to oldest.
 * Returns empty list when none completed.
 *
 * Query params:
 *   - projectId (required): the project to filter by.
 *
 * Requirements: 6.2, 6.3, 6.4
 */

import { NextResponse } from "next/server";
import { editJobsDb } from "@/lib/edit/editJobStore";
import type { EditJobStore } from "@/lib/edit/editJobStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Dependency injection (overridable for tests)
// ---------------------------------------------------------------------------

export interface ListRouteDeps {
  editJobStore: EditJobStore;
}

const defaultDeps: ListRouteDeps = {
  editJobStore: editJobsDb,
};

let currentDeps: ListRouteDeps = defaultDeps;

export function __setDeps(deps: Partial<ListRouteDeps>): void {
  currentDeps = { ...defaultDeps, ...deps };
}

export function __resetDeps(): void {
  currentDeps = defaultDeps;
}

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");

  if (!projectId) {
    return NextResponse.json(
      { error: "Missing required query parameter: projectId" },
      { status: 400 }
    );
  }

  // Get all edit jobs for this project
  const allJobs = currentDeps.editJobStore.listEditJobs(projectId);

  // Filter to only completed jobs with an outputKey (Req 6.2, 6.3)
  const completedJobs = allJobs
    .filter((job) => job.status === "completed" && job.outputKey)
    .sort((a, b) => {
      // Sort by updatedAt descending (most recent completion first) (Req 6.3)
      return b.updatedAt.localeCompare(a.updatedAt);
    })
    .map((job) => ({
      editJobId: job.id,
      projectId: job.projectId,
      outputKey: job.outputKey,
      completedAt: job.updatedAt,
      source: job.source,
      options: job.options,
    }));

  return NextResponse.json({
    outputs: completedJobs,
    total: completedJobs.length,
  });
}
