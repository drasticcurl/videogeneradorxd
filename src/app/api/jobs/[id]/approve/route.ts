/**
 * POST /api/jobs/:id/approve
 * Aprueba un job (imagen o video). Body opcional: { index } para elegir variante.
 * Al aprobar, se desbloquean los pasos que dependian de el (se re-encola el proyecto).
 */
import { approveJob } from "@/lib/jobs/pipeline";
import { enqueueProject } from "@/lib/jobs/queue";
import { requireJobOwner } from "@/lib/ownership";
import { ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const guard = requireJobOwner(params.id);
    if (!guard.ok) return guard.response;
    const job = guard.job;

    const body = (await req.json().catch(() => ({}))) as { index?: number };
    const updated = await approveJob(job.id, body.index);
    // Desbloquea dependientes y continua el pipeline.
    enqueueProject(job.projectId);
    return ok({ approved: true, job: updated });
  } catch (err) {
    return serverError(err);
  }
}
