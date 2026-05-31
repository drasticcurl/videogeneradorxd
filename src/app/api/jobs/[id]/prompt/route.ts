/**
 * POST /api/jobs/:id/prompt
 * Cambia el prompt de la imagen/clip del job y lo regenera.
 * Body: { prompt: string }
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

    const body = (await req.json()) as { prompt?: string };
    const prompt = (body.prompt ?? "").trim();
    if (!prompt) return badRequest("El prompt no puede estar vacio.");

    changePrompt(job.id, prompt);
    enqueueJob(job.id); // regenera con el prompt nuevo
    return ok({ updated: true, job: jobsDb.get(job.id) });
  } catch (err) {
    return serverError(err);
  }
}
