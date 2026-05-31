/**
 * POST /api/jobs/:id/prompt
 * Cambia el prompt (y para videos, el dialogo) del job y lo regenera.
 * Body: { prompt?: string, dialogue?: string, model?: string }
 */
import { jobsDb } from "@/lib/db";
import { changePrompt } from "@/lib/jobs/pipeline";
import { enqueueJob } from "@/lib/jobs/queue";
import { badRequest, notFound, ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const job = jobsDb.get(params.id);
    if (!job) return notFound("Job no encontrado");

    const body = (await req.json()) as {
      prompt?: string;
      dialogue?: string;
      durationSec?: number;
      resolution?: string;
      model?: string;
    };
    const prompt = body.prompt !== undefined ? body.prompt.trim() : undefined;
    if (prompt !== undefined && !prompt) {
      return badRequest("El prompt no puede estar vacio.");
    }

    changePrompt(job.id, {
      prompt,
      dialogue: body.dialogue,
      durationSec: body.durationSec,
      resolution: body.resolution,
      modelOverride: body.model,
    });
    enqueueJob(job.id); // regenera con el prompt/dialogo/duracion (y modelo) nuevo
    return ok({ updated: true, job: jobsDb.get(job.id) });
  } catch (err) {
    return serverError(err);
  }
}
