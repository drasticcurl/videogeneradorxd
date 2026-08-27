/**
 * POST /api/jobs/:id/unapprove
 * Deshace una aprobacion: el job vuelve a "awaiting_approval" con sus candidatos
 * intactos (NO regenera nada, no gasta cuota). Sirve para el "deshacer" de la
 * revision de a una, cuando apretaste aprobar sin querer.
 *
 * Ojo: si el job que depende de este ya arranco, esto no lo cancela.
 */
import { jobsDb } from "@/lib/db";
import { logEvent, refreshManifest } from "@/lib/jobs/pipeline";
import { badRequest, notFound, ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const job = jobsDb.get(params.id);
    if (!job) return notFound("Job no encontrado");
    if (job.status !== "done") {
      return badRequest("Solo se puede deshacer la aprobacion de un job aprobado.");
    }
    if ((job.candidates ?? []).length === 0 && !job.outputPath) {
      return badRequest("No hay nada generado para volver a revisar.");
    }

    const updated = jobsDb.update(job.id, {
      status: "awaiting_approval",
      locked: false,
      error: null,
    });
    logEvent(job.projectId, "warn", `Aprobacion deshecha para "${job.refId}".`, {
      jobId: job.id,
    });
    await refreshManifest(job.projectId);
    return ok({ unapproved: true, job: updated });
  } catch (err) {
    return serverError(err);
  }
}
