/**
 * POST /api/projects/:id/stitch
 * Une los clips en orden en un unico final.mp4 (paso OPCIONAL, requiere ffmpeg).
 */
import { jobsDb, projectsDb } from "@/lib/db";
import { stitchProject } from "@/lib/ffmpeg";
import { writeManifest } from "@/lib/storage";
import { notFound, ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const project = projectsDb.get(params.id);
    if (!project) return notFound("Proyecto no encontrado");

    const result = stitchProject(project.id);
    if (result.ok) {
      await writeManifest(project, jobsDb.byProject(project.id));
    }
    return ok(result);
  } catch (err) {
    return serverError(err);
  }
}
