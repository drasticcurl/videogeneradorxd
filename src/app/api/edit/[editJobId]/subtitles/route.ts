/**
 * GET/POST /api/edit/[editJobId]/subtitles — subtitle-review pass-through.
 *
 * GET  fetches the editor's proposed subtitle groups and returns a normalized
 *      SubtitlesView (editable, groups with read-only timings).
 * POST validates the edited group text (non-empty after trim) and forwards
 *      text-only groups to the editor's /subtitulos/{id} resume endpoint. On
 *      editor 202 the job transitions to running. The group count must match
 *      the proposal (the editor enforces this; a mismatch surfaces as 4xx).
 *
 * Requirements: 2.2, 2.3, 2.4, 2.5, 2.6, 8.3
 */

import { NextResponse } from "next/server";
import { EditorPermanentError } from "@/lib/edit/retry";
import { recoverableLost } from "@/lib/edit/jobReconciler";
import { parseSubtitulosResponse } from "@/components/edit/editUiData";
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
    const editor = await deps.createClient().getSubtitulos(job.editorJobId);
    return NextResponse.json(parseSubtitulosResponse(editor));
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
  if (job.status !== "awaiting_subtitles") {
    return NextResponse.json(
      { error: `expected awaiting_subtitles, got ${job.status}`, editJobId },
      { status: 409 },
    );
  }

  let body: { groups?: unknown };
  try {
    body = (await req.json()) as { groups?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(body.groups)) {
    return NextResponse.json({ error: "Body must include a groups array" }, { status: 400 });
  }
  const groups = body.groups as { texto?: unknown }[];

  const emptyIndices: number[] = [];
  groups.forEach((g, i) => {
    if (typeof g?.texto !== "string" || g.texto.trim().length === 0) {
      emptyIndices.push(i);
    }
  });
  if (emptyIndices.length > 0) {
    return NextResponse.json(
      { error: "empty group text", indices: emptyIndices, status: "awaiting_subtitles" },
      { status: 400 },
    );
  }

  const grupos = groups.map((g) => ({ texto: (g.texto as string).trim() }));

  try {
    await deps.createClient().postSubtitulos(job.editorJobId, { grupos });
  } catch (err) {
    if (err instanceof EditorPermanentError) {
      if (err.statusCode === 404) return recoverableLost(editJobId, deps);
      return NextResponse.json(
        {
          error: "Editor rejected subtitle edit",
          details: err.body ?? err.message,
          status: "awaiting_subtitles",
        },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: "Editor unavailable", status: "awaiting_subtitles" },
      { status: 502 },
    );
  }

  await deps.editJobStore.updateEditJob(editJobId, {
    status: "running",
    progress: { ...job.progress, mensaje: "Resumed after subtitle review", error: null },
  });
  return NextResponse.json({ editJobId, status: "running" }, { status: 202 });
}
