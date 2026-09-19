/**
 * POST /api/imagenes
 * Crea un proyecto de SOLO IMAGENES a partir de UN prompt y lo encola.
 *
 * Acepta DOS content-types, a proposito:
 *  - application/json (como siempre): { nombre, prompt, variantes?, model?,
 *    aspectRatio?, imageSize?, negativePrompt? }. Genera la primera imagen text2image.
 *  - multipart/form-data (nuevo, imagen base): los MISMOS campos como form fields +
 *    `imagenBase` (File). Con archivo, la primera imagen del proyecto es image2image
 *    contra ese archivo (subido como `reference`, mismo mecanismo que usan los
 *    avatares VSL en /api/projects/:id/references) en vez de text2image.
 *
 * Se resuelve por Content-Type y NO por si el campo esta presente: `req.json()`
 * revienta si el body es multipart, asi que hay que saber ANTES de leer el body.
 *
 * UN prompt por proyecto. Los saltos de linea son parte del prompt: un prompt de
 * imagen serio tiene varias lineas (encuadre, luz, estilo, negativos) y partirlo por
 * linea, como se hacia antes, lo convertia en varios prompts cortados al medio. La
 * cantidad se maneja con `variantes`, que son candidatas de la MISMA imagen entre las
 * que se elige.
 *
 * POR QUE ESTA RUTA EXISTE en vez de armar el plan en el cliente: el PlanJSON tiene
 * reglas cruzadas no obvias (la primera imagen de cada asset debe ser text2image, los
 * ids no pueden repetirse, los clips referencian assets e images existentes). Armarlo
 * en el browser significaria duplicar esas reglas y que se desincronicen. Aca se arma
 * server-side y se valida con el MISMO `validatePlan()` que usa el flujo normal.
 *
 * No es un pipeline paralelo: crea un proyecto comun con `clips: []` y reusa la cola,
 * el storage, los reintentos, el rate limit y el auto-approve que ya existen. Un
 * proyecto sin clips solo produce jobs de tipo "image" (ver buildJobs), asi que el
 * pipeline llega a "done" sin tocar Veo y sin gastar un peso de video.
 */
import { randomUUID } from "node:crypto";

import {
  config,
  imageSizesFor,
  resolveAspectRatio,
  resolveModel,
  resolveResolution,
} from "@/lib/config";
import { jobsDb, projectsDb } from "@/lib/db";
import { imageIdPara } from "@/lib/imagenes";
import { buildJobs } from "@/lib/jobs/pipeline";
import { enqueueProject } from "@/lib/jobs/queue";
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

interface ImagenesBody {
  nombre?: string;
  prompt?: string;
  variantes?: number;
  model?: string;
  aspectRatio?: string;
  imageSize?: string;
  negativePrompt?: string;
}

/** Extension a partir del mime type del archivo subido, con fallback al nombre. */
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

    // multipart/form-data si viene una imagen base; si no, el JSON de siempre.
    // Se decide por Content-Type y no leyendo el body primero: `req.json()` en un
    // body multipart tira SyntaxError, asi que hay que elegir el parser ANTES.
    const contentType = req.headers.get("content-type") ?? "";
    const esMultipart = contentType.includes("multipart/form-data");

    let body: ImagenesBody;
    let imagenBase: File | null = null;

    if (esMultipart) {
      const form = await req.formData();
      const archivo = form.get("imagenBase");
      if (archivo instanceof File && archivo.size > 0) imagenBase = archivo;
      const num = (v: FormDataEntryValue | null) =>
        v === null || v === "" ? undefined : Number(v);
      body = {
        nombre: (form.get("nombre") as string) ?? undefined,
        prompt: (form.get("prompt") as string) ?? undefined,
        variantes: num(form.get("variantes")),
        model: (form.get("model") as string) ?? undefined,
        aspectRatio: (form.get("aspectRatio") as string) ?? undefined,
        imageSize: (form.get("imageSize") as string) ?? undefined,
        negativePrompt: (form.get("negativePrompt") as string) ?? undefined,
      };
    } else {
      body = (await req.json()) as ImagenesBody;
    }

    const nombre = (body.nombre ?? "").trim();
    if (!nombre) {
      return badRequest("Falta el nombre del proyecto: se usa para nombrar los archivos.");
    }

    // Se preservan los saltos de linea: son parte del prompt.
    const prompt = (body.prompt ?? "").trim();
    if (!prompt) {
      return badRequest("Falta el prompt de la imagen.");
    }

    const variantes = Math.min(4, Math.max(1, Math.round(body.variantes ?? 2)));
    const model = resolveModel("image", body.model);
    const aspectRatio = resolveAspectRatio(body.aspectRatio);

    /*
      La calidad se RECHAZA si el modelo no la soporta, en vez de bajarla en silencio:
      el lite solo acepta 1K (verificado, con 2K devuelve 400) y si acá se degradara
      sin decir nada, el usuario pediria 4K y recibiria una imagen de 1376px sin
      entender por que. El provider igual la recorta como ultima red de seguridad,
      para que un job nunca muera por esto.
    */
    const permitidas = imageSizesFor(model);
    const imageSize = body.imageSize ?? "1K";
    if (!permitidas.includes(imageSize as (typeof permitidas)[number])) {
      return badRequest(
        `El modelo elegido no soporta calidad ${imageSize}. ` +
          `Solo acepta: ${permitidas.join(", ")}.`,
      );
    }

    const imageId = imageIdPara(nombre);
    const assetId = slugify(nombre) || "imagenes";
    const id = randomUUID();

    // Referencia subida (imagen base): mismo mecanismo que los avatares VSL. El
    // archivo se guarda ANTES de armar el plan porque el plan necesita saber si hay
    // reference para decidir modo text2image vs image2image.
    let referenceId: string | null = null;
    let referenceRelFile: string | null = null;
    if (imagenBase) {
      referenceId = `${assetId}_base`;
      await ensureProjectDirs(id);
      const ext = extFor(imagenBase);
      referenceRelFile = referenceRelPath(referenceId, ext);
      const bytes = new Uint8Array(await imagenBase.arrayBuffer());
      await saveBytes(id, referenceRelFile, bytes);
    }

    // Un solo asset `broll` con UNA imagen. `broll` y no `avatar` porque no hay una
    // persona cuya identidad haya que mantener entre planos.
    // Con imagen base: image2image contra la reference recien subida (mismo caso que
    // valida schema.ts para la primera imagen de un asset: image2image esta permitido
    // ahi SOLO si las referencias son, todas, `references` subidas).
    const planCrudo = {
      global: {
        idioma_dialogo: "es-AR",
        formato: aspectRatio,
        reglas_realismo: "",
        negative_prompt: body.negativePrompt?.trim() ?? "",
      },
      references:
        referenceId && referenceRelFile
          ? [{ id: referenceId, label: `${nombre} (imagen base)`, file: referenceRelFile }]
          : [],
      assets: [
        {
          id: assetId,
          tipo: "broll",
          images: [
            referenceId
              ? { id: imageId, modo: "image2image", ref_image_id: referenceId, prompt }
              : { id: imageId, modo: "text2image", prompt },
          ],
        },
      ],
      // Vacio a proposito: es lo que hace que este proyecto NO genere video.
      clips: [],
      warnings: [],
    };

    // Mismo validador que el flujo normal: si las reglas del plan cambian, esta
    // ruta se rompe en el build o en el test, no en produccion con un plan invalido.
    const validacion = validatePlan(planCrudo);
    if (!validacion.ok) {
      return badRequest(
        "El plan de imágenes no pasó la validación.",
        validacion.errors,
      );
    }

    const ahora = new Date().toISOString();
    const record: ProjectRecord = {
      id,
      name: nombre,
      brief: `Solo imágenes: 1 prompt, ${variantes} variante(s), ${aspectRatio} en ${imageSize}${
        referenceId ? ", con imagen base subida" : ""
      }.`,
      plan: validacion.plan,
      status: "draft",
      // El dueño sale SOLO de la sesion, nunca del body (D3 del plan de aislamiento).
      owner: user,
      models: {
        llm: resolveModel("llm"),
        image: model,
        video: resolveModel("video"),
      },
      imageVariants: variantes,
      defaultResolution: resolveResolution(),
      imageAspectRatio: aspectRatio,
      imageSize,
      // Auto-approve APAGADO a proposito, aunque el default global este en true.
      // El sentido de esta pantalla es elegir entre variantes: si se auto-aprueba la
      // primera, la eleccion ya esta hecha y el boton de elegir no significa nada.
      autoApprove: false,
      outputDir: `${config.storage.outputDir}/${id}`,
      createdAt: ahora,
      updatedAt: ahora,
    };

    projectsDb.upsert(record);
    await ensureProjectDirs(id);

    // Se encola en el acto: en esta pantalla no hay un paso intermedio de revisar el
    // plan como en el flujo de brief, asi que separar crear de generar solo agregaria
    // un request.
    const jobs = buildJobs(record);
    await writeManifest(record, jobs);
    enqueueProject(id);

    return ok(
      {
        project: record,
        jobs: jobsDb.byProject(id),
        totalImagenes: variantes,
      },
      { status: 201 },
    );
  } catch (err) {
    return serverError(err);
  }
}
