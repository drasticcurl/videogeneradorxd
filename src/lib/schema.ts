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
  /** requerido si modo=image2image; apunta a otra Image.id del proyecto */
  ref_image_id: z.string().optional(),
  /** prompt visual en ingles */
  prompt: z.string().min(1, "image.prompt requerido"),
  /** negative prompt opcional por imagen (override del global) */
  negative_prompt: z.string().optional(),
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

    // Validaciones de consistencia por imagen.
    for (const asset of plan.assets) {
      asset.images.forEach((img, idx) => {
        if (img.modo === "image2image") {
          if (!img.ref_image_id) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Image "${img.id}" es image2image pero no tiene ref_image_id.`,
              path: ["assets"],
            });
          } else if (!imageIds.has(img.ref_image_id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Image "${img.id}".ref_image_id "${img.ref_image_id}" no existe en el proyecto.`,
              path: ["assets"],
            });
          } else if (img.ref_image_id === img.id) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Image "${img.id}" no puede referenciarse a si misma.`,
              path: ["assets"],
            });
          }
        }
        // La primera imagen de cada asset deberia ser text2image (estado base).
        if (idx === 0 && img.modo !== "text2image") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `La primera imagen del asset "${asset.id}" deberia ser text2image (estado base).`,
            path: ["assets"],
          });
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
