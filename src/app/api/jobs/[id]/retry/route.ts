/**
 * POST /api/jobs/:id/retry
 * Reintenta / regenera UN job (imagen o clip) sin rehacer el resto del pipeline.
 */
import { jobsDb } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs/queue";
import { notFound, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const job = jobsDb.get(params.id);
  if (!job) return notFound("Job no encontrado");
  enqueueJob(job.id);
  return ok({ requeued: true, job: jobsDb.get(job.id) });
}
