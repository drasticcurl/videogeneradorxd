/**
 * GET /api/edit/[editJobId]/preview/[name] — Range-aware proxy of the editor's
 * intermediate videos for in-browser preview.
 *
 * Proxies the editor `GET /workfile/{editorJobId}/{name}` endpoint. The name is
 * allowlisted ({unido.mp4, cortado.mp4}) and rejected if it contains a path
 * separator or "..". The `Range` request header is forwarded and the editor
 * response is streamed back preserving status (200/206) and the Content-Type,
 * Content-Length, Content-Range, and Accept-Ranges headers, with
 * Cache-Control: no-store.
 *
 * Requirements: 4.1, 4.2, 4.4, 4.5, 8.6
 */

import { NextResponse } from "next/server";
import { EditorTransientError } from "@/lib/edit/retry";
import { getDeps } from "./_deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Intermediate videos eligible for preview. */
const ALLOWLIST = new Set(["unido.mp4", "cortado.mp4"]);

function isAllowedName(name: string): boolean {
  if (!ALLOWLIST.has(name)) return false;
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return false;
  return true;
}

export async function GET(
  req: Request,
  { params }: { params: { editJobId: string; name: string } },
): Promise<Response> {
  const { editJobId, name } = params;
  const deps = getDeps();

  const job = deps.editJobStore.getEditJob(editJobId);
  if (!job) {
    return NextResponse.json({ error: `Edit job not found: ${editJobId}` }, { status: 404 });
  }
  if (!job.editorJobId) {
    return NextResponse.json({ error: "No editor job id assigned", editJobId }, { status: 409 });
  }

  const decoded = (() => {
    try {
      return decodeURIComponent(name);
    } catch {
      return name;
    }
  })();

  if (!isAllowedName(decoded)) {
    return NextResponse.json({ error: `Preview not allowed for name: ${name}` }, { status: 400 });
  }

  const range = req.headers.get("range") ?? undefined;

  let res: Response;
  try {
    res = await deps.createClient().fetchWorkfile(job.editorJobId, decoded, range);
  } catch (err) {
    if (err instanceof EditorTransientError) {
      return NextResponse.json({ error: "Editor unavailable" }, { status: 502 });
    }
    return NextResponse.json({ error: "Editor unavailable" }, { status: 502 });
  }

  if (res.status === 404) {
    return NextResponse.json({ error: "Preview unavailable" }, { status: 404 });
  }

  // Forward status (200/206) + relevant headers; stream the body.
  const headers = new Headers();
  headers.set("Content-Type", res.headers.get("Content-Type") ?? "video/mp4");
  const contentLength = res.headers.get("Content-Length");
  if (contentLength) headers.set("Content-Length", contentLength);
  const contentRange = res.headers.get("Content-Range");
  if (contentRange) headers.set("Content-Range", contentRange);
  headers.set("Accept-Ranges", res.headers.get("Accept-Ranges") ?? "bytes");
  headers.set("Cache-Control", "no-store");

  return new Response(res.body, { status: res.status, headers });
}
