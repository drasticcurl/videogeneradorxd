/**
 * POST /api/projects/:id/images
 * Agrega un TURNO de chat iterativo: una imagen nueva que modifica la ultima imagen
 * aprobada de una cadena, encadenada por `ref_image_id`.
 * Body: { fromImageId: string, prompt: string, variantes?: number }
 *
 * `fromImageId` tiene que ser una Image YA APROBADA (job "done") del plan: es la base
 * sobre la que se pide la modificacion. La nueva imagen queda en modo image2image con
 * ref_image_id=fromImageId, asi que `buildJobs` arma sola la dependencia correcta
 * (mismo mecanismo que ya usan las imagenes VSL que dependen de otra imagen del
 * proyecto — ver `imageRefIds`/`genRef` en jobs/pipeline.ts). No hay logica de
 * dependencias nueva: es la MISMA regla, aplicada a un caso que antes no se ofrecia
 * desde la UI.
 *
 * Por que una Image NUEVA y no `changePrompt` sobre la misma: `changePrompt` + 
 * regenerate REEMPLAZA la imagen existente (mismo job, mismo archivo final), y el
 * pedido es exactamente lo opuesto: conservar cada paso del chat visible y poder
 * volver a cualquiera. Cada turno es un job aparte, con su propio historial de
 * variantes y aprobacion.
 *
 * variantes: default al `imageVariants` del proyecto. Si se pide un numero distinto,
 * se actualiza `project.imageVariants` (es un campo por PROYECTO, no por imagen —
 * mismo esquema que ya usa el resto del pipeline, ver `buildJobs`), asi que el nuevo
 * valor tambien queda como default para el proximo turno. No afecta a las imagenes ya
 * aprobadas (quedan `locked`/`done` y no se regeneran), solo al numero que se les
 * muestra.
 */
import { chatTurnImageId, buildChatHistory } from "@/lib/imagenes";
import { jobsDb, projectsDb } from "@/lib/db";
import { buildJobs, imageJobId } from "@/lib/jobs/pipeline";
import { enqueueProject } from "@/lib/jobs/queue";
import { validatePlan } from "@/lib/schema";
import { writeManifest } from "@/lib/storage";
import { requireProjectOwner } from "@/lib/ownership";
import type { ProjectPlan } from "@/lib/schema";
import { badRequest, notFound, ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const guard = requireProjectOwner(params.id);
    if (!guard.ok) return guard.response;

    const project = projectsDb.get(params.id);
    if (!project) return notFound("Proyecto no encontrado");

    const body = (await req.json().catch(() => ({}))) as {
      fromImageId?: string;
      prompt?: string;
      variantes?: number;
    };

    const fromImageId = (body.fromImageId ?? "").trim();
    if (!fromImageId) {
      return badRequest("Falta fromImageId: la imagen sobre la que se pide el cambio.");
    }

    const prompt = (body.prompt ?? "").trim();
    if (!prompt) {
      return badRequest("Falta el prompt de la modificación.");
    }

    // La imagen base del turno tiene que existir en el plan Y estar aprobada: generar
    // image2image contra algo que todavia no tiene archivo en disco revienta en
    // runImageGeneration ("La imagen de referencia todavia no esta aprobada"). Se
    // valida ACA, antes de tocar el plan, para devolver un 400 claro en vez de que el
    // job nazca y falle solo en la cola.
    const fromJob = jobsDb.get(imageJobId(project.id, fromImageId));
    let existeEnPlan = false;
    for (const asset of project.plan.assets) {
      if (asset.images.some((i) => i.id === fromImageId)) existeEnPlan = true;
    }
    if (!existeEnPlan) {
      return badRequest(`La imagen "${fromImageId}" no existe en este proyecto.`);
    }
    if (!fromJob || fromJob.status !== "done" || !fromJob.outputPath) {
      return badRequest(
        `La imagen "${fromImageId}" todavía no está aprobada. Elegí una variante antes de seguir el chat.`,
      );
    }

    // El id base del chat es el de la PRIMERA imagen de la cadena (v1, sin sufijo):
    // si fromImageId ya es un turno ("crema_manos_v2"), el proximo turno sigue desde
    // la misma raiz ("crema_manos_v3") y no anida sufijos ("crema_manos_v2_v3").
    const base = fromImageId.replace(/_v\d+$/, "");
    const asset = project.plan.assets.find((a) =>
      a.images.some((i) => i.id === fromImageId),
    );
    if (!asset) return badRequest(`No se encontró el asset de "${fromImageId}".`);

    const usados = new Set(asset.images.map((i) => i.id));
    let turno = 2;
    let newImageId = chatTurnImageId(base, turno);
    while (usados.has(newImageId)) {
      turno += 1;
      newImageId = chatTurnImageId(base, turno);
    }
    // Salvaguarda: si por algun motivo el id calculado coincide con uno existente
    // (no deberia, por el while de arriba), no lo pisamos en silencio.
    if (usados.has(newImageId)) {
      return badRequest("No se pudo generar un id nuevo para la imagen del chat.");
    }

    const variantes = Math.min(
      4,
      Math.max(1, Math.round(body.variantes ?? project.imageVariants ?? 2)),
    );

    const plan: ProjectPlan = {
      ...project.plan,
      assets: project.plan.assets.map((a) =>
        a.id !== asset.id
          ? a
          : {
              ...a,
              images: [
                ...a.images,
                {
                  id: newImageId,
                  modo: "image2image" as const,
                  ref_image_id: fromImageId,
                  prompt,
                },
              ],
            },
      ),
    };

    const validacion = validatePlan(plan);
    if (!validacion.ok) {
      return badRequest("El turno del chat no pasó la validación del plan.", validacion.errors);
    }

    projectsDb.update(project.id, { plan: validacion.plan, imageVariants: variantes });
    const updated = projectsDb.get(project.id)!;

    // buildJobs es idempotente y detecta la dependencia sola: newImageId es
    // image2image con ref_image_id=fromImageId, que ESTA en generatedImageIds (es una
    // Image del plan, no una reference subida), asi que el job nuevo nace con
    // dependsOn=imageJobId(fromImageId) y la cola lo corre apenas exista (ya esta
    // done, asi que corre de una).
    const jobs = buildJobs(updated);
    await writeManifest(updated, jobs);
    enqueueProject(updated.id);

    const newJob = jobsDb.get(imageJobId(updated.id, newImageId));

    return ok(
      {
        created: true,
        imageId: newImageId,
        job: newJob,
        jobs: jobsDb.byProject(updated.id).filter((j) => j.type === "image"),
        // La cadena completa v1 -> v2 -> v3, ya ordenada: el cliente la puede usar
        // para pintar el historial sin tener que re-seguir `ref_image_id` el mismo, y
        // sirve de chequeo cruzado contra lo que el cliente ya arma solo con el
        // manifest (si alguna vez difieren, es señal de un bug de un lado o del otro).
        history: buildChatHistory(validacion.plan, newImageId),
      },
      { status: 201 },
    );
  } catch (err) {
    return serverError(err);
  }
}
