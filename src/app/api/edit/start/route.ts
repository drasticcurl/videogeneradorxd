/**
 * POST /api/edit/start — Start a new edit job.
 *
 * This is the BFF entry point for the generator → editor integration.
 * It orchestrates:
 *   1. Parse request body: { projectId, source?, options, music?, overrides? }
 *   2. Resolve source (default to clips if not specified)
 *   3. Merge ordering with b-roll if ordering is provided
 *   4. Create EditJob (status: queued)
 *   5. Upload inputs to storage adapter (status: uploading)
 *   6. Build Ajustes and call editor /procesar
 *   7. On success: store editorJobId, set status: running, return 202 { editJobId }
 *   8. On editor invalid-request: set failed, retain options, surface editor details
 *   9. On upload failure: set failed with actionable error, leave already-uploaded inputs
 *
 * Requirements: 1.1, 1.7, 1.8, 2.6, 11.1
 */

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import { EditorPermanentError } from "@/lib/edit/retry";
import { buildAjustes } from "@/lib/edit/buildAjustes";
import { handleMusicUpload, validateMusicFormat } from "@/lib/edit/musicUpload";
import {
  resolveSource,
  resolveDefaultSource,
  mergeOrdering,
  buildDefaultOrdering,
} from "@/lib/edit/resolveInputs";
import type {
  EditJob,
  EditSource,
  EditOptions,
  EditorProcesarRequest,
} from "@/lib/edit/types";
import type { MusicUploadInput } from "@/lib/edit/musicUpload";
import { getDeps } from "./_deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Request body shape
// ---------------------------------------------------------------------------

interface StartEditRequestBody {
  projectId: string;
  source?: EditSource;
  options: EditOptions;
  /** Optional music upload as base64 data. */
  music?: {
    data: string; // base64
    mimeType: string;
    fileName: string;
  };
  /** Optional safe overrides for the Ajustes payload. */
  overrides?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(req: Request): Promise<Response> {
  const currentDeps = getDeps();

  // 1. Parse request body
  let body: StartEditRequestBody;
  try {
    body = (await req.json()) as StartEditRequestBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const { projectId, source, options, music, overrides } = body;

  console.log("[edit/start] Received request", { projectId, sourceType: source?.type ?? "default(clips)" });

  if (!projectId || typeof projectId !== "string") {
    return NextResponse.json(
      { error: "Missing or invalid projectId" },
      { status: 400 }
    );
  }

  if (!options || typeof options !== "object") {
    return NextResponse.json(
      { error: "Missing or invalid options" },
      { status: 400 }
    );
  }

  // Validate music format early (Req 2.5) — reject before any upload
  if (music) {
    const formatError = validateMusicFormat(music.mimeType);
    if (formatError) {
      return NextResponse.json(
        { error: formatError },
        { status: 400 }
      );
    }
  }

  // 2. Resolve source (default to clips if not specified) (Req 1.3)
  const resolvedSourceResult = source
    ? resolveSource(projectId, source)
    : resolveDefaultSource(projectId);

  if (resolvedSourceResult.error) {
    return NextResponse.json(
      { error: resolvedSourceResult.error },
      { status: 400 }
    );
  }

  const generatedInputs = resolvedSourceResult.inputs!;

  console.log("[edit/start] Source resolved", { inputCount: generatedInputs.length });

  // 3. Merge ordering with b-roll if ordering is provided (Req 1.7)
  const brollBank = currentDeps.getBrollBank();
  let finalOrdering;

  if (options.ordering && options.ordering.length > 0) {
    const mergeResult = await mergeOrdering(
      generatedInputs,
      options.ordering,
      brollBank
    );
    if (mergeResult.error) {
      return NextResponse.json(
        { error: mergeResult.error },
        { status: 400 }
      );
    }
    finalOrdering = mergeResult.ordenClips!;
  } else {
    // Use natural order of generated inputs (no b-roll)
    finalOrdering = generatedInputs;
  }

  console.log("[edit/start] Ordering merged", { count: finalOrdering.length });

  // 4. Create EditJob (status: queued)
  const editJobId = crypto.randomUUID();
  const now = new Date().toISOString();

  const editJob: EditJob = {
    id: editJobId,
    projectId,
    source: source ?? { type: "clips", clipIds: generatedInputs.map((i) => i.id) },
    options,
    status: "queued",
    editorJobId: null,
    progress: {
      porcentaje: 0,
      pasoActual: null,
      mensaje: "Job queued",
      error: null,
    },
    outputKey: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };

  await currentDeps.editJobStore.createEditJob(editJob);

  console.log("[edit/start] EditJob created", { editJobId });

  // 5. Upload inputs to storage adapter (status: uploading) (Req 11.1)
  await currentDeps.editJobStore.updateEditJob(editJobId, { status: "uploading" });

  const adapter = currentDeps.getStorageAdapter(projectId);
  const ordenClipsKeys: string[] = [];

  console.log(`[edit/start] Uploading ${finalOrdering.length} inputs...`);

  try {
    for (const input of finalOrdering) {
      const fileData = await fsp.readFile(input.absPath);
      const fileName = input.absPath.split("/").pop() ?? `clip_${input.id}.mp4`;
      console.log("[edit/start] Uploading file", { name: fileName, size: fileData.byteLength });
      const key = await adapter.putInput(editJobId, fileName, new Uint8Array(fileData));
      ordenClipsKeys.push(key);
    }
  } catch (err: unknown) {
    // Upload failure: set failed with actionable error, leave already-uploaded inputs (Req 11.1)
    const message =
      err instanceof Error
        ? `Input upload failed: ${err.message}`
        : "Input upload failed: unknown error";

    await currentDeps.editJobStore.updateEditJob(editJobId, {
      status: "failed",
      error: { paso: "UPLOAD", motivo: message },
      progress: {
        porcentaje: 0,
        pasoActual: "UPLOAD",
        mensaje: message,
        error: { paso: "UPLOAD", motivo: message },
      },
    });

    return NextResponse.json(
      { error: message, editJobId },
      { status: 500 }
    );
  }

  console.log("[edit/start] All inputs uploaded", { ordenClipsKeys });

  // Handle optional music upload (Req 2.2, 2.3)
  let musicInputKey: string | undefined;
  if (music) {
    const musicData: MusicUploadInput = {
      data: new Uint8Array(Buffer.from(music.data, "base64")),
      mimeType: music.mimeType,
      fileName: music.fileName,
    };

    const musicResult = await handleMusicUpload(editJobId, musicData, adapter);
    if (musicResult.error) {
      // This shouldn't happen (we validated above), but handle defensively
      await currentDeps.editJobStore.updateEditJob(editJobId, {
        status: "failed",
        error: { paso: "UPLOAD", motivo: musicResult.error },
      });
      return NextResponse.json(
        { error: musicResult.error, editJobId },
        { status: 400 }
      );
    }
    musicInputKey = musicResult.inputKey;
    console.log("[edit/start] Music uploaded", { key: musicInputKey });
  }

  // 6. Build Ajustes and call editor /procesar (Req 2.4)
  const ajustes = buildAjustes({
    editOptions: options,
    musicInputKey,
    overrides,
  });

  const procesarRequest: EditorProcesarRequest = {
    orden_clips: ordenClipsKeys,
    ajustes,
    ...(musicInputKey ? { musica_id: musicInputKey } : {}),
  };

  const client = currentDeps.createClient();

  console.log(`[edit/start] Calling editor /procesar at ${client.baseUrl}`, {
    payload: JSON.stringify(procesarRequest),
  });

  try {
    const response = await client.procesar(procesarRequest);

    console.log("[edit/start] Editor accepted", { job_id: response.job_id });

    // 7. On success: store editorJobId, set status: running, return 202 (Req 1.8)
    await currentDeps.editJobStore.updateEditJob(editJobId, {
      status: "running",
      editorJobId: response.job_id,
      progress: {
        porcentaje: 0,
        pasoActual: null,
        mensaje: "Editor job started",
        error: null,
      },
    });

    return NextResponse.json({ editJobId }, { status: 202 });
  } catch (err: unknown) {
    if (err instanceof EditorPermanentError) {
      // 8. On editor invalid-request (4xx): set failed, retain options, surface editor details (Req 2.6)
      let details: string;
      try {
        details = typeof err.body === "string" ? err.body : JSON.stringify(err.body);
      } catch {
        details = err.message;
      }

      console.log("[edit/start] Editor rejected (4xx)", {
        statusCode: err.statusCode,
        body: err.body,
        message: err.message,
      });

      await currentDeps.editJobStore.updateEditJob(editJobId, {
        status: "failed",
        error: {
          paso: "PROCESAR",
          motivo: `Editor rejected request: ${details}`,
        },
        progress: {
          porcentaje: 0,
          pasoActual: "PROCESAR",
          mensaje: `Editor rejected request: ${details}`,
          error: {
            paso: "PROCESAR",
            motivo: `Editor rejected request: ${details}`,
          },
        },
      });

      return NextResponse.json(
        {
          error: "Editor rejected the request",
          details,
          editJobId,
        },
        { status: 400 }
      );
    }

    // Other errors (transient exhausted, network, etc.)
    const errObj = err as Error & { code?: string; cause?: unknown };
    console.log("[edit/start] Editor call FAILED", {
      message: errObj.message,
      stack: errObj.stack,
      code: errObj.code,
      cause: errObj.cause,
      name: errObj.name,
    });

    const message =
      err instanceof Error
        ? `Editor call failed: ${err.message}`
        : "Editor call failed: unknown error";

    await currentDeps.editJobStore.updateEditJob(editJobId, {
      status: "failed",
      error: { paso: "PROCESAR", motivo: message },
      progress: {
        porcentaje: 0,
        pasoActual: "PROCESAR",
        mensaje: message,
        error: { paso: "PROCESAR", motivo: message },
      },
    });

    return NextResponse.json(
      { error: message, editJobId },
      { status: 502 }
    );
  }
}
