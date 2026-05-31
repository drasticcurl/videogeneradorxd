/**
 * POST /api/projects/:id/control
 * Body: { action: "pause" | "resume" | "cancel" }
 * Controla la ejecucion del pipeline del proyecto.
 */
import { projectsDb } from "@/lib/db";
import {
  cancelProject,
  pauseProject,
  resumeProject,
} from "@/lib/jobs/queue";
import { badRequest, notFound, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const project = projectsDb.get(params.id);
  if (!project) return notFound("Proyecto no encontrado");

  const body = (await req.json().catch(() => ({}))) as { action?: string };
  switch (body.action) {
    case "pause":
      pauseProject(project.id);
      break;
    case "resume":
      resumeProject(project.id);
      break;
    case "cancel":
      cancelProject(project.id);
      break;
    default:
      return badRequest("action debe ser pause | resume | cancel");
  }
  return ok({ ok: true, status: projectsDb.get(project.id)?.status });
}
