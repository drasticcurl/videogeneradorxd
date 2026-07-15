/**
 * B-roll bank BFF routes.
 *
 * POST /api/edit/broll — Upload a b-roll clip (multipart/form-data, "file" field).
 * GET  /api/edit/broll — List all b-roll clips with metadata.
 *
 * Requirements: 3.1, 3.2
 */

import { NextResponse } from "next/server";
import { BrollBank } from "@/lib/edit/brollBank";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Shared bank instance (reuses the default data dir from config).
function getBank(): BrollBank {
  return new BrollBank();
}

/**
 * POST /api/edit/broll
 *
 * Accepts multipart/form-data with a "file" field.
 * Returns the uploaded clip metadata on success (201),
 * or a 400 error with validation details on failure.
 */
export async function POST(req: Request): Promise<Response> {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Request must be multipart/form-data" },
      { status: 400 }
    );
  }

  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json(
      { error: 'Missing "file" field in form data' },
      { status: 400 }
    );
  }

  const mimeType = file.type || "application/octet-stream";
  const arrayBuffer = await file.arrayBuffer();
  const data = new Uint8Array(arrayBuffer);

  const bank = getBank();
  const { result, error } = await bank.upload(file.name, mimeType, data);

  if (error) {
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        ...(error.supportedFormats && { supportedFormats: error.supportedFormats }),
        ...(error.allowedRange && { allowedRange: error.allowedRange }),
      },
      { status: 400 }
    );
  }

  return NextResponse.json(result, { status: 201 });
}

/**
 * GET /api/edit/broll
 *
 * Returns JSON list of all b-roll clips:
 * [{ id, name, durationSec, uploadedAt }, ...]
 */
export async function GET(): Promise<Response> {
  const bank = getBank();
  const clips = await bank.list();
  return NextResponse.json(clips, { status: 200 });
}
