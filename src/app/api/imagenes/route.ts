/**
 * POST /api/imagenes
 * Crea un proyecto de SOLO IMAGENES a partir de una lista de prompts y lo encola.
 * Body: { nombre: string, prompts: string[], variantes?: number, model?: string,
 *         negativePrompt?: string }
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

import { config, resolveModel, resolveResolution } from "@/lib/config";
import { jobsDb, projectsDb } from "@/lib/db";
import { imageIdsPara, parsePrompts } from "@/lib/imagenes";
import { buildJobs } from "@/lib/jobs/pipeline";
import { enqueueProject } from "@/lib/jobs/queue";
import { validatePlan } from "@/lib/schema";
import { ensureProjectDirs, slugify, writeManifest } from "@/lib/storage";
import type { ProjectRecord } from "@/lib/types";
import { badRequest, ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Tope de prompts por tanda. Es un guardrail de costo, no una limitacion tecnica. */
const MAX_PROMPTS = 40;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      nombre?: string;
      prompts?: unknown;
      variantes?: number;
      model?: string;
      negativePrompt?: string;
    };

    const nombre = (body.nombre ?? "").trim();
    if (!nombre) {
      return badRequest("Falta el nombre del proyecto: se usa para nombrar los archivos.");
    }

    // Se acepta un array o el texto pegado tal cual, para que el cliente pueda
    // mandar lo que tiene sin preprocesar.
    const prompts = Array.isArray(body.prompts)
      ? body.prompts.map((p) => String(p ?? "").trim()).filter(Boolean)
      : parsePrompts(String(body.prompts ?? ""));

    if (prompts.length === 0) {
      return badRequest("No hay ningún prompt. Pegá uno por línea.");
    }
    if (prompts.length > MAX_PROMPTS) {
      return badRequest(
        `Son ${prompts.length} prompts y el máximo por tanda es ${MAX_PROMPTS}. ` +
          `Con variantes eso serían ${prompts.length * (body.variantes ?? 2)} imágenes de una sola vez.`,
      );
    }

    const variantes = Math.min(4, Math.max(1, Math.round(body.variantes ?? 2)));
    const ids = imageIdsPara(nombre, prompts.length);

    // Un solo asset `broll` con todas las imagenes en text2image. `broll` y no
    // `avatar` porque no hay una persona cuya identidad haya que mantener entre
    // planos: cada prompt es independiente.
    const planCrudo = {
      global: {
        idioma_dialogo: "es-AR",
        formato: "9:16",
        reglas_realismo: "",
        negative_prompt: body.negativePrompt?.trim() ?? "",
      },
      references: [],
      assets: [
        {
          id: slugify(nombre) || "imagenes",
          tipo: "broll",
          images: prompts.map((prompt, i) => ({
            id: ids[i],
            modo: "text2image",
            prompt,
          })),
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

    const id = randomUUID();
    const ahora = new Date().toISOString();
    const record: ProjectRecord = {
      id,
      name: nombre,
      brief: `Solo imágenes: ${prompts.length} prompt(s), ${variantes} variante(s) cada uno.`,
      plan: validacion.plan,
      status: "draft",
      models: {
        llm: resolveModel("llm"),
        image: resolveModel("image", body.model),
        video: resolveModel("video"),
      },
      imageVariants: variantes,
      defaultResolution: resolveResolution(),
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
        totalImagenes: prompts.length * variantes,
      },
      { status: 201 },
    );
  } catch (err) {
    return serverError(err);
  }
}
