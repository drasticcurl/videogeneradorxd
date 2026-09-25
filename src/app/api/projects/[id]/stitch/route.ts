/**
 * POST /api/projects/:id/stitch
 * Une los clips en orden en un unico <nombre-del-proyecto>.mp4 (OPCIONAL, requiere ffmpeg).
 */
import { jobsDb, projectsDb } from "@/lib/db";
import { stitchProject } from "@/lib/ffmpeg";
import { writeManifest } from "@/lib/storage";
import { requireProjectOwner } from "@/lib/ownership";
import { notFound, ok, serverError } from "@/lib/http";
import { corridaVivaDe } from "@/lib/voz/estado";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const guard = requireProjectOwner(params.id);
    if (!guard.ok) return guard.response;

    const project = projectsDb.get(params.id);
    if (!project) return notFound("Proyecto no encontrado");

    /*
      Volver a unir a mitad de un cambio de voz cambia el archivo del que la corrida le
      esta sacando el audio (D17). Misma forma de respuesta que un stitch fallido, asi
      la UI muestra `reason` sin cambios.
    */
    if (corridaVivaDe(project)) {
      return ok(
        {
          ok: false,
          reason:
            "Hay un cambio de voz en curso en este proyecto. Esperá a que termine o cancelalo.",
        },
        { status: 409 }
      );
    }

    const result = stitchProject(project.id);
    if (result.ok && result.receta) {
      projectsDb.update(project.id, { recetaUnido: result.receta });
    }
    if (result.ok) {
      // Releido: despues de escribir, se lee de nuevo y no se reusa la copia de antes.
      await writeManifest(projectsDb.get(project.id)!, jobsDb.byProject(project.id));
    }
    return ok(result);
  } catch (err) {
    return serverError(err);
  }
}
