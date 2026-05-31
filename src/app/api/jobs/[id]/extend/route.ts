/**
 * POST /api/jobs/:id/extend
 * Extiende un video YA generado agregando 7s de continuacion (Veo) y concatena.
 * Corre en background (es un LRO largo); la UI lo ve via polling de /jobs.
 */
import { jobsDb } from "@/lib/db";
import { extendVideoJob, logEvent } from "@/lib/jobs/pipeline";
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
    if (job.type !== "video") {
      return badRequest("Solo se pueden extender videos.");
    }
    if (!job.outputPath) {
      return badRequest("No hay un video generado para extender. Genéralo primero.");
    }

    // Marcamos generando y corremos en background (no bloqueamos la respuesta HTTP).
    jobsDb.update(job.id, { status: "generating", error: null });
    void (async () => {
      try {
        await extendVideoJob(job.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        jobsDb.update(job.id, { status: "failed", error: message });
        logEvent(job.projectId, "error", `Extender "${job.refId}" fallo: ${message}`, {
          jobId: job.id,
        });
      }
    })();

    return ok({ extending: true, job: jobsDb.get(job.id) });
  } catch (err) {
    return serverError(err);
  }
}
