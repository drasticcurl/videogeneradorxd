/**
 * POST /api/jobs/:id/approve
 * Aprueba un job (imagen o video). Body opcional: { index } para elegir variante.
 * Al aprobar, se desbloquean los pasos que dependian de el (se re-encola el proyecto).
 */
import { jobsDb } from "@/lib/db";
import { approveJob } from "@/lib/jobs/pipeline";
import { enqueueProject } from "@/lib/jobs/queue";
import { notFound, ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const job = jobsDb.get(params.id);
    if (!job) return notFound("Job no encontrado");

    const body = (await req.json().catch(() => ({}))) as { index?: number };
    const updated = await approveJob(job.id, body.index);
    // Desbloquea dependientes y continua el pipeline.
    enqueueProject(job.projectId);
    return ok({ approved: true, job: updated });
  } catch (err) {
    return serverError(err);
  }
}
