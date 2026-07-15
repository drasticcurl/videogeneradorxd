/**
 * POST /api/edit/[editJobId]/confirm — Confirm a paused manual-edit step.
 *
 * When an Edit_Job is in awaiting_edit status, the user confirms the manual
 * edit step. This forwards the confirmation to the editor's resume endpoint
 * and transitions the job to running on acceptance.
 *
 * Requirements: 5.9, 5.12
 */

import { NextResponse } from "next/server";
import { editJobsDb } from "@/lib/edit/editJobStore";
import { createEditorClient } from "@/lib/edit/editorClient";
import { EditorPermanentError } from "@/lib/edit/retry";
import type { EditJobStore } from "@/lib/edit/editJobStore";
import type { EditorClient } from "@/lib/edit/editorClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Dependency injection (overridable for tests)
// ---------------------------------------------------------------------------

export interface ConfirmRouteDeps {
  editJobStore: EditJobStore;
  createClient: () => EditorClient;
}

const defaultDeps: ConfirmRouteDeps = {
  editJobStore: editJobsDb,
  createClient: () => createEditorClient(),
};

let currentDeps: ConfirmRouteDeps = defaultDeps;

export function __setDeps(deps: Partial<ConfirmRouteDeps>): void {
  currentDeps = { ...defaultDeps, ...deps };
}

export function __resetDeps(): void {
  currentDeps = defaultDeps;
}

// ---------------------------------------------------------------------------
// Extended EditorClient type with confirm capability
// ---------------------------------------------------------------------------

/**
 * The editor's resume/confirm endpoint accepts a POST to /confirmar/{id}.
 * We'll use a custom fetch call via the client's baseUrl for this.
 */
interface ConfirmableClient extends EditorClient {
  confirmar?: (editorJobId: string) => Promise<{ ok: boolean }>;
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(
  _req: Request,
  { params }: { params: { editJobId: string } }
): Promise<Response> {
  const { editJobId } = params;

  // Look up the EditJob
  const job = currentDeps.editJobStore.getEditJob(editJobId);
  if (!job) {
    return NextResponse.json(
      { error: `Edit job not found: ${editJobId}` },
      { status: 404 }
    );
  }

  // Only allow confirmation when status is awaiting_edit (Req 5.9)
  if (job.status !== "awaiting_edit") {
    return NextResponse.json(
      {
        error: `Cannot confirm: job status is "${job.status}", expected "awaiting_edit"`,
        editJobId,
      },
      { status: 409 }
    );
  }

  if (!job.editorJobId) {
    return NextResponse.json(
      { error: "Cannot confirm: no editor job ID assigned", editJobId },
      { status: 409 }
    );
  }

  // Forward confirmation to the editor's resume endpoint
  const client = currentDeps.createClient() as ConfirmableClient;

  try {
    // Use the confirmar method if available (injected in tests),
    // otherwise call the editor's /confirmar/{id} endpoint directly
    if (client.confirmar) {
      await client.confirmar(job.editorJobId);
    } else {
      // Direct fetch to the editor's confirmation endpoint
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      try {
        const response = await fetch(
          `${client.baseUrl}/confirmar/${encodeURIComponent(job.editorJobId)}`,
          {
            method: "POST",
            signal: controller.signal,
            headers: { "Content-Type": "application/json" },
          }
        );
        if (response.status >= 400) {
          const bodyText = await response.text().catch(() => "");
          throw new EditorPermanentError(
            `Editor rejected confirmation: ${bodyText}`,
            response.status,
            bodyText
          );
        }
      } finally {
        clearTimeout(timer);
      }
    }

    // On acceptance: set status to running (Req 5.9)
    await currentDeps.editJobStore.updateEditJob(editJobId, {
      status: "running",
      progress: {
        ...job.progress,
        mensaje: "Resumed after manual edit confirmation",
        error: null,
      },
    });

    return NextResponse.json({
      editJobId,
      status: "running",
      message: "Confirmation accepted, job resumed",
    });
  } catch (err: unknown) {
    // On rejection: keep awaiting_edit and surface error (Req 5.12)
    const message =
      err instanceof EditorPermanentError
        ? `Confirmation rejected: ${err.body ?? err.message}`
        : err instanceof Error
          ? `Confirmation failed: ${err.message}`
          : "Confirmation failed: unknown error";

    return NextResponse.json(
      {
        error: message,
        editJobId,
        status: "awaiting_edit",
      },
      { status: 422 }
    );
  }
}
