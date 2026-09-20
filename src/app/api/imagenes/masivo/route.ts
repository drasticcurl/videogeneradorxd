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
 *
 * ─── "PROMPT DUAL" (dual=true): 4 VARIANTES FIJAS, 2 PROMPTS x 2 MODELOS ─────
 *
 * En vez de un solo prompt con N variantes del mismo modelo, el switch "Prompt dual"
 * pide DOS prompts (A: variación conservadora, "no cambies mucho"; B: libre, "usá la
 * foto de referencia y armá el ad") y arma SIEMPRE 4 variantes por foto, cruzando
 * cada prompt con cada modelo:
 *
 *   v1 = prompt A + Flash   v2 = prompt B + Flash
 *   v3 = prompt A + Pro     v4 = prompt B + Pro
 *
 * `variantes` del form se IGNORA si `dual` viene true (se fuerza a 4 en el backend,
 * no solo deshabilitado en la UI: un cliente que mande otra cosa no tiene que poder
 * saltarse la regla). El plan por variante viaja en `job.meta.variantPlan` (ver
 * `VariantPlanEntry` en types.ts) y lo interpreta `runImageGeneration` — el resto del
 * pipeline (reintentos, backoff, persistencia incremental, auto-approve) es EXACTAMENTE
 * el mismo camino que una imagen con variantes normales; lo unico que cambia es de
 * donde sale el prompt/modelo de cada request individual.
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
import { buildJobs, imageJobId } from "@/lib/jobs/pipeline";
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
import type { ProjectRecord, VariantPlanEntry } from "@/lib/types";
import { badRequest, ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Los dos modelos que se alternan. Fijo: no es elegible desde el form (ver arriba). */
const MODELOS_ALTERNADOS = ["gemini-3-pro-image", "gemini-3.1-flash-image"] as const;
/** Mismos dos modelos, con nombre por rol para armar el cruce de "prompt dual". */
const MODELO_PRO = "gemini-3-pro-image";
const MODELO_FLASH = "gemini-3.1-flash-image";

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

    // "Prompt dual": dos prompts en vez de uno, ver el comentario del encabezado.
    // El flag viaja como string ("true"/"false") porque FormData no tiene booleanos.
    const dual = (form.get("dual") as string) === "true";

    // Mismas reglas que /api/imagenes: se preservan los saltos de linea, son parte
    // del prompt (encuadre, luz, estilo, negativos en renglones distintos).
    const prompt = ((form.get("prompt") as string) ?? "").trim();
    const promptA = ((form.get("promptA") as string) ?? "").trim();
    const promptB = ((form.get("promptB") as string) ?? "").trim();

    if (dual) {
      if (!promptA) {
        return badRequest('Falta el prompt A ("variación casi igual").');
      }
      if (!promptB) {
        return badRequest('Falta el prompt B ("libertad para armar el ad").');
      }
    } else if (!prompt) {
      return badRequest("Falta el prompt de la variación.");
    }

    const numField = (v: FormDataEntryValue | null) =>
      v === null || v === "" ? undefined : Number(v);
    // Con prompt dual las 4 variantes son FIJAS (2 prompts x 2 modelos): lo que venga
    // en `variantes` se ignora. No es solo la UI la que lo deshabilita — se fuerza
    // aca tambien para que un cliente que mande otra cosa no pueda saltarse la regla
    // (ver el comentario del encabezado).
    const variantes = dual
      ? 4
      : Math.min(4, Math.max(1, Math.round(numField(form.get("variantes")) ?? 2)));
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
      // Sin dual: alterna Pro/Flash POR PROYECTO, como siempre. Con dual, el modelo
      // ya no se decide por proyecto sino POR VARIANTE (cada foto usa los dos, ver
      // variantPlan mas abajo) — el modelo que queda acá es solo el "nominal" del
      // proyecto (el que se muestra en la UI y se usaría si algo regenerara sin
      // variantPlan), y se elige Flash por ser el primero en el orden de variantes.
      const modelo = dual
        ? MODELO_FLASH
        : MODELOS_ALTERNADOS[i % MODELOS_ALTERNADOS.length];
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

      // El prompt que queda en el PLAN (y por lo tanto en el manifest/UI como "el
      // prompt de la imagen") es promptA en modo dual: es el conservador, el mas
      // parecido a "el prompt de esta imagen" en el sentido de siempre. promptB solo
      // vive en el variantPlan, ligado a las variantes 2 y 4.
      const promptEfectivo = dual ? promptA : prompt;

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
              {
                id: imageId,
                modo: "image2image",
                ref_image_id: referenceId,
                prompt: promptEfectivo,
              },
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
        brief: dual
          ? `Generador masivo (prompt dual): 4 variantes fijas (A+Flash, B+Flash, A+Pro, B+Pro), ` +
            `${aspectRatio} en ${imageSize}, foto ${i + 1}/${fotos.length} de la tanda.`
          : `Generador masivo: 1 prompt, ${variantes} variante(s), ${aspectRatio} en ${imageSize}, foto ${
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

      // "Prompt dual": el plan por variante se guarda en `job.meta.variantPlan`
      // DESPUES de crear el job (buildJobs no sabe nada de esto — ver el contrato en
      // VariantPlanEntry, types.ts). Se busca el job por id derivado en vez de asumir
      // que es `jobs[0]`: un proyecto de esta pantalla tiene exactamente UNA imagen,
      // pero buscarlo por id explícito no depende de esa asunción si algún día deja
      // de serlo.
      if (dual) {
        const imgJobId = imageJobId(id, imageId);
        const variantPlan: VariantPlanEntry[] = [
          { prompt: promptA, model: MODELO_FLASH, label: "A" },
          { prompt: promptB, model: MODELO_FLASH, label: "B" },
          { prompt: promptA, model: MODELO_PRO, label: "A" },
          { prompt: promptB, model: MODELO_PRO, label: "B" },
        ];
        const imgJob = jobsDb.get(imgJobId);
        if (imgJob) {
          jobsDb.update(imgJobId, { meta: { ...imgJob.meta, variantPlan } });
        }
      }

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
