/** GET /api/edit/[editJobId]/progress — reconcile and return edit progress. */

import { NextResponse } from "next/server";
import { reconcileEditJob } from "@/lib/edit/jobReconciler";
import { getDeps } from "./_deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { editJobId: string } }
): Promise<Response> {
  const { editJobId } = params;
  const currentDeps = getDeps();
  const existing = currentDeps.editJobStore.getEditJob(editJobId);
  if (!existing) {
    return NextResponse.json(
      { error: `Edit job not found: ${editJobId}` },
      { status: 404 }
    );
  }

  const result = await reconcileEditJob(editJobId, currentDeps);
  const job = result?.job ?? existing;
  return NextResponse.json({
    editJobId: job.id,
    status: job.status,
    progress: job.progress,
    live: result?.live ?? false,
    ...(result?.message ? { message: result.message } : {}),
  });
}
