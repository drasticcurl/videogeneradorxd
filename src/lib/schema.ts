/**
 * Esquemas Zod del PlanJSON (salida del parser) y tipos derivados.
 *
 * El parser (Gemini) devuelve un Project que validamos con estos esquemas antes
 * de armar el pipeline. Tambien validamos en el cliente (validacion en vivo del editor).
 */
import { z } from "zod";

export const ASPECT_RATIOS = ["9:16", "16:9", "1:1", "4:3", "3:4"] as const;

export const ImageSchema = z.object({
  id: z.string().min(1, "image.id requerido"),
  modo: z.enum(["text2image", "image2image"]),
  /**
   * Requerido si modo=image2image. Apunta a otra Image.id del proyecto, O a una
   * Reference.id (foto/avatar subido por el usuario, ver ProjectPlan.references).
   */
  ref_image_id: z.string().optional(),
  /**
   * Referencias MULTIPLES (VSL): permite combinar varias fotos/imagenes de identidad
   * en una misma generacion (ej. dos personas en el mismo plano). Cada id puede ser
   * una Image.id previa o una Reference.id (foto subida).
   */
  ref_image_ids: z.array(z.string()).optional(),
  /** prompt visual en ingles */
  prompt: z.string().min(1, "image.prompt requerido"),
  /** negative prompt opcional por imagen (override del global) */
  negative_prompt: z.string().optional(),
});

/**
 * Imagen de REFERENCIA subida por el usuario (VSL): foto real de la persona/avatar
 * que se usa como fuente de identidad para generar TODOS los planos de esa persona.
 * `file` se completa cuando se sube el archivo al proyecto (relativo a output/<id>/).
 */
export const ReferenceImageSchema = z.object({
  id: z.string().min(1, "reference.id requerido"),
  /** etiqueta humana, ej "Natalia Reyes" */
  label: z.string().optional(),
  /** path relativo del archivo subido (references/<id>.png); null hasta que se sube */
  file: z.string().optional(),
});

export const AssetSchema = z.object({
  id: z.string().min(1, "asset.id requerido"),
  tipo: z.enum(["avatar", "broll"]),
  images: z.array(ImageSchema).default([]),
});

export const ClipSchema = z.object({
  id: z.string().min(1, "clip.id requerido"),
  orden: z.number().int().nonnegative(),
  asset_id: z.string().min(1, "clip.asset_id requerido"),
  image_id: z.string().min(1, "clip.image_id requerido"),
  /** prompt de video en ingles */
  video_prompt: z.string().min(1, "clip.video_prompt requerido"),
  /** dialogo en idioma_dialogo (es-AR vos); "" si b-roll mudo */
  dialogo: z.string().default(""),
  duracion_seg: z.number().positive(),
  etiqueta: z.enum(["IA", "FILMAR_REAL"]),
  on_screen_text: z.string().optional(),
  /** resolucion del video para este clip; si falta, usa el default del proyecto */
  resolucion: z.enum(["720p", "1080p"]).optional(),
  /**
   * OVERRIDE del prompt final que se manda a Veo. Si tiene contenido, se usa TAL CUAL
   * (ignora el armado automatico con estilo UGC/selfie + lip-sync + voz/acento). Sirve
   * para clips donde el armado por defecto no aplica (ej. b-roll que no debe mostrar una
   * persona hablando). Si esta vacio/ausente, el prompt se arma automaticamente como siempre.
   */
  final_prompt: z.string().optional(),
});

export const GlobalSchema = z.object({
  idioma_dialogo: z.string().default("es-AR"),
  formato: z.string().default("9:16"),
  reglas_realismo: z.string().default(""),
  negative_prompt: z.string().default(""),
});

export const ProjectPlanSchema = z
  .object({
    global: GlobalSchema,
    /** fotos/avatares de referencia subidos por el usuario (VSL). */
    references: z.array(ReferenceImageSchema).default([]),
    assets: z.array(AssetSchema).default([]),
    clips: z.array(ClipSchema).default([]),
    /** supuestos / defaults que el parser tuvo que rellenar */
    warnings: z.array(z.string()).default([]),
  })
  .superRefine((plan, ctx) => {
    // Indexamos todas las imagenes por id (para validar referencias cruzadas).
    const imageIds = new Set<string>();
    const imageById = new Map<string, z.infer<typeof ImageSchema>>();
    const assetByImageId = new Map<string, string>();

    for (const asset of plan.assets) {
      for (const img of asset.images) {
        if (imageIds.has(img.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `image.id duplicado: "${img.id}"`,
            path: ["assets"],
          });
        }
        imageIds.add(img.id);
        imageById.set(img.id, img);
        assetByImageId.set(img.id, asset.id);
      }
    }

    // Indexamos las referencias subidas (VSL) y validamos que no colisionen con image ids.
    const referenceIds = new Set<string>();
    for (const ref of plan.references ?? []) {
      if (referenceIds.has(ref.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `reference.id duplicado: "${ref.id}"`,
          path: ["references"],
        });
      }
      if (imageIds.has(ref.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `reference.id "${ref.id}" colisiona con una image.id; usá ids distintos.`,
          path: ["references"],
        });
      }
      referenceIds.add(ref.id);
    }

    // Devuelve todos los ids de referencia de una imagen (ref_image_id + ref_image_ids), sin duplicados.
    const refsOf = (img: z.infer<typeof ImageSchema>): string[] => {
      const set = new Set<string>();
      if (img.ref_image_id) set.add(img.ref_image_id);
      for (const r of img.ref_image_ids ?? []) set.add(r);
      return [...set];
    };

    // Validaciones de consistencia por imagen.
    for (const asset of plan.assets) {
      asset.images.forEach((img, idx) => {
        if (img.modo === "image2image") {
          const refs = refsOf(img);
          if (refs.length === 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Image "${img.id}" es image2image pero no tiene ref_image_id ni ref_image_ids.`,
              path: ["assets"],
            });
          }
          for (const r of refs) {
            if (r === img.id) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Image "${img.id}" no puede referenciarse a si misma.`,
                path: ["assets"],
              });
            } else if (!imageIds.has(r) && !referenceIds.has(r)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Image "${img.id}" referencia "${r}" que no existe (ni como image ni como reference).`,
                path: ["assets"],
              });
            }
          }
        }
        // La primera imagen de cada asset debe ser text2image (estado base),
        // O image2image construida SOLO a partir de referencias subidas (VSL: la
        // foto real de la persona es la fuente de identidad de su imagen base).
        if (idx === 0 && img.modo !== "text2image") {
          const refs = refsOf(img);
          const allUploadedRefs =
            refs.length > 0 && refs.every((r) => referenceIds.has(r));
          if (!allUploadedRefs) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `La primera imagen del asset "${asset.id}" debe ser text2image, o image2image basada en una imagen de referencia subida (references).`,
              path: ["assets"],
            });
          }
        }
      });
    }

    // Validaciones de clips: image_id y asset_id deben existir.
    const seenOrden = new Set<number>();
    const assetIds = new Set(plan.assets.map((a) => a.id));
    for (const clip of plan.clips) {
      if (!assetIds.has(clip.asset_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Clip "${clip.id}".asset_id "${clip.asset_id}" no existe.`,
          path: ["clips"],
        });
      }
      if (!imageIds.has(clip.image_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Clip "${clip.id}".image_id "${clip.image_id}" no existe.`,
          path: ["clips"],
        });
      }
      if (seenOrden.has(clip.orden)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Orden de clip duplicado: ${clip.orden} (clip "${clip.id}").`,
          path: ["clips"],
        });
      }
      seenOrden.add(clip.orden);
    }
  });

export type Image = z.infer<typeof ImageSchema>;
export type ReferenceImage = z.infer<typeof ReferenceImageSchema>;
export type Asset = z.infer<typeof AssetSchema>;
export type Clip = z.infer<typeof ClipSchema>;
export type GlobalConfig = z.infer<typeof GlobalSchema>;
export type ProjectPlan = z.infer<typeof ProjectPlanSchema>;

/**
 * Parsea/valida un plan crudo (objeto JS) devolviendo el resultado tipado o los issues.
 * Usado tanto en backend (despues de Gemini) como podria usarse en cliente.
 */
export function validatePlan(raw: unknown):
  | { ok: true; plan: ProjectPlan }
  | { ok: false; errors: { path: string; message: string }[] } {
  const result = ProjectPlanSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, plan: result.data };
  }
  return {
    ok: false,
    errors: result.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    })),
  };
}
