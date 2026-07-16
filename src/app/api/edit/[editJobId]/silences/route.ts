/**
 * GET/POST /api/edit/[editJobId]/silences — silence-editing pass-through.
 *
 * GET  fetches the editor's silence pause payload and returns a normalized
 *      SilencesView (editable, previewUrl, durationS, fps, width, height,
 *      segments).
 * POST validates the edited cut segments and forwards them to the editor's
 *      /silencios/{id} resume endpoint. On editor 202 the job transitions to
 *      running.
 *
 * Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 4.3, 8.1, 8.2
 */

import { NextResponse } from "next/server";
import { EditorPermanentError } from "@/lib/edit/retry";
import { recoverableLost } from "@/lib/edit/jobReconciler";
import { validateSegments, type SilenceSegment } from "@/lib/edit/validateSegments";
import { parseSilencesResponse } from "@/components/edit/editUiData";
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
    return NextResponse.json(
      { error: "No editor job id assigned", editJobId },
      { status: 409 },
    );
  }

  try {
    const editor = await deps.createClient().getSilencios(job.editorJobId);
    return NextResponse.json(parseSilencesResponse(editJobId, editor));
  } catch (err) {
    if (err instanceof EditorPermanentError && err.statusCode === 404) {
      return recoverableLost(editJobId, deps);
    }
    return NextResponse.json(
      { error: "Editor unavailable", status: job.status },
      { status: 502 },
    );
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
    return NextResponse.json(
      { error: "No editor job id assigned", editJobId },
      { status: 409 },
    );
  }
  if (job.status !== "awaiting_silences") {
    return NextResponse.json(
      { error: `expected awaiting_silences, got ${job.status}`, editJobId },
      { status: 409 },
    );
  }

  let body: { segments?: unknown };
  try {
    body = (await req.json()) as { segments?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(body.segments)) {
    return NextResponse.json({ error: "Body must include a segments array" }, { status: 400 });
  }
  const segments = body.segments as SilenceSegment[];

  const client = deps.createClient();

  // Fetch the authoritative duration from the editor pause payload.
  let durationS: number;
  try {
    const sil = await client.getSilencios(job.editorJobId);
    durationS = typeof sil.duracion_s === "number" ? sil.duracion_s : 0;
  } catch (err) {
    if (err instanceof EditorPermanentError && err.statusCode === 404) {
      return recoverableLost(editJobId, deps);
    }
    return NextResponse.json(
      { error: "Editor unavailable", status: "awaiting_silences" },
      { status: 502 },
    );
  }

  const errs = validateSegments(segments, durationS);
  if (errs.length > 0) {
    return NextResponse.json(
      { error: "invalid cut segments", details: errs, status: "awaiting_silences" },
      { status: 400 },
    );
  }

  const tramos = segments.map((s) => ({ inicio_s: s.inicioS, fin_s: s.finS }));
  try {
    await client.postSilencios(job.editorJobId, { tramos });
  } catch (err) {
    if (err instanceof EditorPermanentError) {
      if (err.statusCode === 404) return recoverableLost(editJobId, deps);
      return NextResponse.json(
        {
          error: "Editor rejected silence edit",
          details: err.body ?? err.message,
          status: "awaiting_silences",
        },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: "Editor unavailable", status: "awaiting_silences" },
      { status: 502 },
    );
  }

  await deps.editJobStore.updateEditJob(editJobId, {
    status: "running",
    progress: { ...job.progress, mensaje: "Resumed after silence edit", error: null },
  });
  return NextResponse.json({ editJobId, status: "running" }, { status: 202 });
}
