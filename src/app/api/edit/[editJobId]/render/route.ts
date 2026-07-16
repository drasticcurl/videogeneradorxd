/**
 * GET/POST /api/edit/[editJobId]/render — final-render pass-through.
 *
 * GET  fetches the editor's final-render pause payload and returns a normalized
 *      FinalRenderView (editable, previewUrl of cortado.mp4, groups, extraTexts,
 *      dimensions).
 * POST validates the optional extra "hook" texts (max 2) and the engine value
 *      (if present, must equal exactly "remotion"), then forwards
 *      {textos_extra, motor:"remotion"} to the editor's /render/{id} resume
 *      endpoint. On editor 202 the job transitions to running.
 *
 * Requirements: 3.2, 3.3, 3.4, 3.5, 4.3, 8.4, 8.5
 */

import { NextResponse } from "next/server";
import { EditorPermanentError } from "@/lib/edit/retry";
import { recoverableLost } from "@/lib/edit/jobReconciler";
import { parseRenderResponse } from "@/components/edit/editUiData";
import type { EditorTextoExtra } from "@/lib/edit/editorClient";
import { getDeps } from "./_deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { editJobId: string } },
): Promise<Response> {
  const { editJobId } = params;
  const deps = getDeps();

  const job = deps.editJobStore.getEditJob(editJobId);
  if (!job) {
    return NextResponse.json({ error: `Edit job not found: ${editJobId}` }, { status: 404 });
  }
  if (!job.editorJobId) {
    return NextResponse.json({ error: "No editor job id assigned", editJobId }, { status: 409 });
  }

  try {
    const editor = await deps.createClient().getRender(job.editorJobId);
    return NextResponse.json(parseRenderResponse(editJobId, editor));
  } catch (err) {
    if (err instanceof EditorPermanentError && err.statusCode === 404) {
      return recoverableLost(editJobId, deps);
    }
    return NextResponse.json({ error: "Editor unavailable", status: job.status }, { status: 502 });
  }
}

export async function POST(
  req: Request,
  { params }: { params: { editJobId: string } },
): Promise<Response> {
  const { editJobId } = params;
  const deps = getDeps();

  const job = deps.editJobStore.getEditJob(editJobId);
  if (!job) {
    return NextResponse.json({ error: `Edit job not found: ${editJobId}` }, { status: 404 });
  }
  if (!job.editorJobId) {
    return NextResponse.json({ error: "No editor job id assigned", editJobId }, { status: 409 });
  }
  if (job.status !== "awaiting_final_render") {
    return NextResponse.json(
      { error: `expected awaiting_final_render, got ${job.status}`, editJobId },
      { status: 409 },
    );
  }

  let body: { extraTexts?: unknown; motor?: unknown };
  try {
    body = (await req.json()) as { extraTexts?: unknown; motor?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const extraTexts = (body.extraTexts ?? []) as EditorTextoExtra[];
  if (!Array.isArray(extraTexts)) {
    return NextResponse.json({ error: "extraTexts must be an array" }, { status: 400 });
  }
  if (extraTexts.length > 2) {
    return NextResponse.json(
      { error: "max 2 extra texts", status: "awaiting_final_render" },
      { status: 400 },
    );
  }
  if (body.motor !== undefined && body.motor !== "remotion") {
    return NextResponse.json(
      { error: 'motor must equal "remotion"', status: "awaiting_final_render" },
      { status: 400 },
    );
  }

  try {
    await deps.createClient().postRender(job.editorJobId, {
      textos_extra: extraTexts,
      motor: "remotion",
    });
  } catch (err) {
    if (err instanceof EditorPermanentError) {
      if (err.statusCode === 404) return recoverableLost(editJobId, deps);
      return NextResponse.json(
        {
          error: "Editor rejected render",
          details: err.body ?? err.message,
          status: "awaiting_final_render",
        },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: "Editor unavailable", status: "awaiting_final_render" },
      { status: 502 },
    );
  }

  await deps.editJobStore.updateEditJob(editJobId, {
    status: "running",
    progress: { ...job.progress, mensaje: "Final render started", error: null },
  });
  return NextResponse.json({ editJobId, status: "running" }, { status: 202 });
}
