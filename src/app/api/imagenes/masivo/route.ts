/**
 * POST /api/imagenes/masivo
 *
 * Generador masivo de variaciones: UN prompt + N fotos subidas -> crea N proyectos de
 * SOLO IMAGENES (uno por foto, image2image contra esa foto, mismo mecanismo que
 * `/api/imagenes` con `imagenBase`), y los corre SECUENCIAL en vez de en paralelo.
 *
 * Pensado para el caso real que lo origino: subir 10 fotos de un mismo creativo y
 * pedir la misma variacion a todas ("dibujo tu alma gemela", etc). Un solo proyecto
 * con 10 imagenes ya existia como opcion (un asset con 10 images), pero se descarto:
 * el PlanJSON exige que la PRIMERA imagen de un asset sea `image2image` solo contra
 * `references` subidas, y meter 10 referencias + 10 images en un mismo asset/plan
 * hubiera significado tocar `schema.ts`, `batch.ts` y la UI de revision para que
 * soporten "N imagenes base sueltas" en un solo proyecto — mucho riesgo para un caso
 * que ya resuelve bien crear N proyectos chicos. Reutilizando N veces el mismo camino
 * que `/api/imagenes` ya prueba, no hay pipeline nuevo que mantener.
 *
 * ─── LOS DOS MECANISMOS ANTI RATE-LIMIT (el motivo de este endpoint) ─────────
 *
 * Generar 10 fotos x variantes de una sola vez saturaba la cuota por minuto de un
 * solo modelo y los jobs terminaban failed tras agotar los reintentos (10, ver
 * config.pipeline.rateLimitMaxAttempts). Dos mitigaciones, ninguna alcanza sola:
 *
 *  1. ALTERNAR MODELO por proyecto: par-Pro/impar-Flash (`gemini-3-pro-image` /
 *     `gemini-3.1-flash-image`). Dos proyectos corriendo cerca en el tiempo pegan
 *     contra cuotas DISTINTAS, asi que no se suman contra el mismo limite. Fijo y no
 *     elegible en el form: el punto es que el usuario no tenga que pensar en esto.
 *  2. SECUENCIAL entre proyectos (`startBatch`/`notifyProjectFinished` en
 *     jobs/masivo.ts): el proyecto N+1 no se encola hasta que el N termino. Con
 *     `PIPELINE_CONCURRENCY=3` (default) cada proyecto individual sigue corriendo sus
 *     variantes en paralelo entre si (eso ya funcionaba y no rompe nada), pero nunca
 *     hay DOS PROYECTOS de la tanda corriendo a la vez, que es lo que multiplicaba la
 *     carga por N.
 *
 * ─── AUTO-APPROVE EN true, A DIFERENCIA DE /api/imagenes ─────────────────────
 *
 * `/api/imagenes` (la pantalla "Generar") fuerza `autoApprove: false` porque su UI es
 * justamente para elegir entre variantes a mano. Esta pantalla es lo opuesto: "generar
 * muchos creativos de golpe" sin sentarse a aprobar cada uno — si no, con 10 fotos en
 * modo manual, la tanda se frena esperando aprobacion antes de arrancar la SIGUIENTE
 * (el gate por lotes no aplica porque son proyectos distintos, pero igual quedarian
 * las 10 en awaiting_approval sin avanzar solas). Con auto-approve, cada job pasa a
 * "done" solo al terminar (con la variante que salga, o la primera de varias) y el
 * proyecto llega a un status terminal sin intervencion, que es la condicion que
 * `notifyProjectFinished` necesita para arrancar el siguiente.
 */
import { randomUUID } from "node:crypto";

import {
  config,
  imageSizesFor,
  resolveAspectRatio,
  resolveResolution,
} from "@/lib/config";
import { jobsDb, projectsDb } from "@/lib/db";
import { imageIdPara } from "@/lib/imagenes";
import { buildJobs } from "@/lib/jobs/pipeline";
import { enqueueProject } from "@/lib/jobs/queue";
import { startBatch } from "@/lib/jobs/masivo";
import { validatePlan } from "@/lib/schema";
import {
  ensureProjectDirs,
  referenceRelPath,
  saveBytes,
  slugify,
  writeManifest,
} from "@/lib/storage";
import { sessionUser } from "@/lib/ownership";
import type { ProjectRecord } from "@/lib/types";
import { badRequest, ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Los dos modelos que se alternan. Fijo: no es elegible desde el form (ver arriba). */
const MODELOS_ALTERNADOS = ["gemini-3-pro-image", "gemini-3.1-flash-image"] as const;

/** Cuantas fotos acepta una sola tanda. Une un limite de UX con uno de sanidad de
 *  recursos: 30 proyectos secuenciales con reintentos ya es una corrida de horas, y
 *  mas que eso probablemente sea un usuario subiendo la carpeta equivocada. */
const MAX_FOTOS = 30;

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
function extFor(file: File): string {
  const byMime = MIME_EXT[file.type];
  if (byMime) return byMime;
  const dot = (file.name ?? "").lastIndexOf(".");
  if (dot >= 0) {
    const ext = file.name.slice(dot + 1).toLowerCase();
    if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) {
      return ext === "jpeg" ? "jpg" : ext;
    }
  }
  return "png";
}

export async function POST(req: Request) {
  try {
    const user = sessionUser();
    if (!user) {
      return ok({ error: "No autenticado. Volvé a entrar." }, { status: 401 });
    }

    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return badRequest("Esta ruta espera multipart/form-data (N fotos + un prompt).");
    }

    const form = await req.formData();

    // Multiples archivos con el MISMO nombre de campo: FormData los junta en
    // getAll(). El input del cliente manda `fotos` repetido, uno por archivo elegido.
    const fotos = form
      .getAll("fotos")
      .filter((f): f is File => f instanceof File && f.size > 0);
    if (fotos.length === 0) {
      return badRequest("Subí al menos una foto para variar.");
    }
    if (fotos.length > MAX_FOTOS) {
      return badRequest(`Máximo ${MAX_FOTOS} fotos por tanda (subiste ${fotos.length}).`);
    }

    const nombreBase = ((form.get("nombreBase") as string) ?? "").trim();
    if (!nombreBase) {
      return badRequest("Falta el nombre de la tanda: se usa para nombrar los proyectos.");
    }

    // Mismas reglas que /api/imagenes: se preservan los saltos de linea, son parte
    // del prompt (encuadre, luz, estilo, negativos en renglones distintos).
    const prompt = ((form.get("prompt") as string) ?? "").trim();
    if (!prompt) {
      return badRequest("Falta el prompt de la variación.");
    }

    const numField = (v: FormDataEntryValue | null) =>
      v === null || v === "" ? undefined : Number(v);
    const variantes = Math.min(4, Math.max(1, Math.round(numField(form.get("variantes")) ?? 2)));
    const aspectRatio = resolveAspectRatio((form.get("aspectRatio") as string) ?? undefined);
    const negativePrompt = ((form.get("negativePrompt") as string) ?? "").trim();

    /*
      La calidad se valida UNA VEZ contra los dos modelos alternados: si alguno de los
      dos no soporta la calidad pedida, se rechaza toda la tanda antes de crear ningun
      proyecto. Validar por-proyecto dejaria la tanda mitad creada mitad rechazada a la
      mitad del loop, que es un estado mucho mas confuso que fallar rapido al principio.
    */
    const imageSize = (form.get("imageSize") as string) ?? "1K";
    for (const modelo of MODELOS_ALTERNADOS) {
      const permitidas = imageSizesFor(modelo);
      if (!permitidas.includes(imageSize as (typeof permitidas)[number])) {
        return badRequest(
          `La calidad ${imageSize} no la soportan los dos modelos que alterna esta pantalla. ` +
            `Nano Banana Pro y Flash aceptan: ${permitidas.join(", ")}.`
        );
      }
    }

    const batchId = randomUUID();
    const ahora = new Date().toISOString();
    const projectIds: string[] = [];

    // Se crean los N proyectos ANTES de encolar nada: si alguno falla a mitad de
    // camino (ej. un archivo corrupto), no queda una tanda con proyectos ya corriendo
    // y otros que nunca se van a crear.
    for (let i = 0; i < fotos.length; i++) {
      const foto = fotos[i];
      const modelo = MODELOS_ALTERNADOS[i % MODELOS_ALTERNADOS.length];
      const nombre = `${nombreBase} ${i + 1}`;
      const imageId = imageIdPara(nombre);
      const assetId = slugify(nombre) || `imagenes_${i + 1}`;
      const id = randomUUID();

      const referenceId = `${assetId}_base`;
      await ensureProjectDirs(id);
      const ext = extFor(foto);
      const referenceRelFile = referenceRelPath(referenceId, ext);
      const bytes = new Uint8Array(await foto.arrayBuffer());
      await saveBytes(id, referenceRelFile, bytes);

      const planCrudo = {
        global: {
          idioma_dialogo: "es-AR",
          formato: aspectRatio,
          reglas_realismo: "",
          negative_prompt: negativePrompt,
        },
        references: [
          { id: referenceId, label: `${nombre} (foto original)`, file: referenceRelFile },
        ],
        assets: [
          {
            id: assetId,
            tipo: "broll",
            images: [
              { id: imageId, modo: "image2image", ref_image_id: referenceId, prompt },
            ],
          },
        ],
        clips: [],
        warnings: [],
      };

      const validacion = validatePlan(planCrudo);
      if (!validacion.ok) {
        return badRequest(
          `El plan de la foto ${i + 1} no pasó la validación.`,
          validacion.errors
        );
      }

      const record: ProjectRecord = {
        id,
        name: nombre,
        brief: `Generador masivo: 1 prompt, ${variantes} variante(s), ${aspectRatio} en ${imageSize}, foto ${
          i + 1
        }/${fotos.length} de la tanda (${modelo}).`,
        plan: validacion.plan,
        status: "draft",
        owner: user,
        models: {
          llm: config.models.llm,
          image: modelo,
          video: config.models.video,
        },
        imageVariants: variantes,
        defaultResolution: resolveResolution(),
        imageAspectRatio: aspectRatio,
        imageSize,
        // true a proposito, al reves que /api/imagenes: ver el comentario del
        // encabezado de este archivo.
        autoApprove: true,
        batch: { batchId, position: i, total: fotos.length },
        outputDir: `${config.storage.outputDir}/${id}`,
        createdAt: ahora,
        updatedAt: ahora,
      };

      projectsDb.upsert(record);
      const jobs = buildJobs(record);
      await writeManifest(record, jobs);
      projectIds.push(id);
    }

    // Recien ACA se arranca la cola, y solo para el primero: startBatch encola
    // projectIds[0] y jobs/masivo.ts encola el resto de a uno, a medida que cada
    // proyecto anterior llega a done/partial/failed (hook en queue.ts).
    startBatch(batchId, projectIds, enqueueProject);

    return ok(
      {
        batchId,
        projects: projectIds.map((id) => projectsDb.get(id)).filter(Boolean),
        total: projectIds.length,
      },
      { status: 201 }
    );
  } catch (err) {
    return serverError(err);
  }
}
