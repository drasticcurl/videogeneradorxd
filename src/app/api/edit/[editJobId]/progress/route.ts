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
  const correlation = result?.correlation;
  return NextResponse.json({
    editJobId: job.id,
    status: job.status,
    progress: job.progress,
    live: result?.live ?? false,
    // Correlation tuple (spec `unir-step-hang`, Task 3.4). Emitted both as a
    // structured `correlation` object and spread at the top level so the
    // tolerant `parseProgressResponse` (Task 3.2) surfaces version/revision/
    // editorJobId to the live log. Never includes video content.
    ...(correlation ? { correlation } : {}),
    ...(correlation?.editorJobId ? { editorJobId: correlation.editorJobId } : {}),
    ...(correlation?.version ? { version: correlation.version } : {}),
    ...(correlation?.revision ? { revision: correlation.revision } : {}),
    ...(result?.message ? { message: result.message } : {}),
  });
}
