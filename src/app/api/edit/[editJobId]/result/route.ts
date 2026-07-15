/**
 * GET /api/edit/[editJobId]/result — Stream or redirect to the finished edited video.
 *
 * For completed jobs with present output:
 *   - If a signed URL is available (cloud mode), redirect to it (TTL 60..3600s).
 *   - Otherwise, stream video/mp4 honoring HTTP Range for partial content.
 * Rejects non-completed jobs.
 * Returns 500 + marks needs-re-run when completed but output absent.
 *
 * Requirements: 6.5, 6.9, 6.10
 */

import { NextResponse } from "next/server";
import { getSignedUrlTtlSec } from "@/lib/edit/config";
import { getDeps } from "./_deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

export async function GET(
  req: Request,
  { params }: { params: { editJobId: string } }
): Promise<Response> {
  const { editJobId } = params;
  const currentDeps = getDeps();

  // Look up the EditJob
  const job = currentDeps.editJobStore.getEditJob(editJobId);
  if (!job) {
    return NextResponse.json(
      { error: `Edit job not found: ${editJobId}` },
      { status: 404 }
    );
  }

  // Reject non-completed jobs (Req 6.9)
  if (job.status !== "completed") {
    return NextResponse.json(
      {
        error: "Output not yet available: job is not completed",
        editJobId,
        status: job.status,
      },
      { status: 409 }
    );
  }

  // Completed but no outputKey means something is very wrong
  if (!job.outputKey) {
    // Mark needs-re-run (Req 6.10)
    await currentDeps.editJobStore.updateEditJob(editJobId, {
      error: { paso: "OUTPUT", motivo: "Output key missing on completed job" },
    });
    return NextResponse.json(
      {
        error: "Output object absent from store. Job needs re-run.",
        editJobId,
        needsRerun: true,
      },
      { status: 500 }
    );
  }

  const adapter = currentDeps.getStorageAdapter(job.projectId);

  // Try signed URL first (cloud mode)
  const ttl = Math.max(60, Math.min(3600, getSignedUrlTtlSec()));
  const signedUrl = await adapter.signedGetUrl(job.outputKey, ttl);

  if (signedUrl) {
    return NextResponse.redirect(signedUrl, 302);
  }

  // Local mode: stream the file, honoring Range headers (Req 6.5)
  // Parse the outputKey to extract editJobId and relative key
  // outputKey format: "edit-io/<editJobId>/outputs/<filename>"
  const outputParts = job.outputKey.split("/");
  // The relKey is after "edit-io/<editJobId>/outputs/"
  const outputsIdx = outputParts.indexOf("outputs");
  const relKey = outputsIdx >= 0
    ? outputParts.slice(outputsIdx + 1).join("/")
    : outputParts[outputParts.length - 1];

  // Extract the editJobId from the key (second segment)
  const keyEditJobId = outputParts.length > 1 ? outputParts[1] : editJobId;

  try {
    const rangeHeader = req.headers.get("range");

    if (rangeHeader) {
      // Parse Range header
      const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
      if (match) {
        const totalSize = adapter.getOutputSize
          ? await adapter.getOutputSize(keyEditJobId, relKey)
          : (await adapter.getOutputStream(keyEditJobId, relKey)).length;

        const start = match[1] ? parseInt(match[1], 10) : 0;
        const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;

        if (start <= end && end < totalSize) {
          const rangedData = await adapter.getOutputStream(keyEditJobId, relKey, { start, end });
          return new Response(Buffer.from(rangedData), {
            status: 206,
            headers: {
              "Content-Type": "video/mp4",
              "Content-Length": String(end - start + 1),
              "Content-Range": `bytes ${start}-${end}/${totalSize}`,
              "Accept-Ranges": "bytes",
              "Cache-Control": "no-store",
            },
          });
        }
      }
    }

    // Full content
    const data = await adapter.getOutputStream(keyEditJobId, relKey);
    return new Response(Buffer.from(data), {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(data.length),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    // Output object absent from store (Req 6.10)
    await currentDeps.editJobStore.updateEditJob(editJobId, {
      error: { paso: "OUTPUT", motivo: "Output object not found in store" },
    });
    return NextResponse.json(
      {
        error: "Output object absent from store. Job needs re-run.",
        editJobId,
        needsRerun: true,
      },
      { status: 500 }
    );
  }
}
