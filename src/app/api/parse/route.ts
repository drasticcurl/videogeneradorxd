/**
 * POST /api/parse
 * Body: { brief: string, model?: string, imageVariants?: number, references?: {id,label}[] }
 * Interpreta el brief con la LLM (Gemini en vertex / mock) y devuelve el PlanJSON
 * estructurado + validado, junto con la estimacion de costo. NO crea proyecto todavia.
 */
import { cookies } from "next/headers";
import { getLlmProvider } from "@/lib/providers";
import { estimateCost } from "@/lib/jobs/pipeline";
import { resolveModel } from "@/lib/config";
import { slugify } from "@/lib/storage";
import { badRequest, ok, serverError } from "@/lib/http";
import { currentUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    // Todavia no hay proyecto (ni dueño): la cuenta de Vertex sale de la sesion. Es
    // IDENTIDAD (auth.ts), no un chequeo de dueño: aca no hay nada que autorizar.
    const usuario = currentUser(cookies());
    if (!usuario) return ok({ error: "No autenticado. Volvé a entrar." }, { status: 401 });

    const body = (await req.json()) as {
      brief?: string;
      model?: string;
      imageVariants?: number;
      references?: { id?: string; label?: string }[];
    };
    const brief = (body.brief ?? "").trim();
    if (!brief) {
      return badRequest("El brief esta vacio. Pegá el texto con las escenas.");
    }
    // Normalizamos las referencias (avatares ya subidos): ids slug, sin vacios.
    const references = (body.references ?? [])
      .map((r) => ({ id: slugify(String(r.id ?? "")), label: r.label }))
      .filter((r) => r.id.length > 0);

    const model = resolveModel("llm", body.model);
    const plan = await getLlmProvider().parseBrief(brief, {
      usuario,
      model,
      references: references.length > 0 ? references : undefined,
    });

    // Garantizamos que TODAS las referencias provistas existan en plan.references
    // (aunque la LLM se las haya olvidado), asi la subida posterior las puede mapear.
    if (references.length > 0) {
      const existing = new Map((plan.references ?? []).map((r) => [r.id, r]));
      for (const ref of references) {
        if (!existing.has(ref.id)) {
          existing.set(ref.id, { id: ref.id, label: ref.label });
        } else if (ref.label && !existing.get(ref.id)!.label) {
          existing.get(ref.id)!.label = ref.label;
        }
      }
      plan.references = Array.from(existing.values());
    }

    // Seguro por si la LLM igual arranco al avatar con text2image: la foto subida es
    // la identidad, asi que la imagen base de su asset (mismo id) parte SIEMPRE de ella.
    // Sin esto, el primer plano sale con una cara inventada y todos los image2image
    // que cuelgan de el heredan esa cara, no la de la foto.
    for (const ref of references) {
      const base = plan.assets.find((a) => a.id === ref.id)?.images[0];
      if (base && base.modo === "text2image") {
        base.modo = "image2image";
        base.ref_image_id = ref.id;
        plan.warnings = [
          ...(plan.warnings ?? []),
          `La imagen base "${base.id}" venia como text2image; se forzo image2image desde el avatar "${ref.id}".`,
        ];
      }
    }
    const sinUsar = references.filter(
      (ref) =>
        !plan.assets.some((a) =>
          a.images.some(
            (img) => img.ref_image_id === ref.id || img.ref_image_ids?.includes(ref.id),
          ),
        ),
    );
    if (sinUsar.length > 0) {
      plan.warnings = [
        ...(plan.warnings ?? []),
        `Ninguna imagen usa el avatar ${sinUsar.map((r) => `"${r.id}"`).join(", ")}: revisá que el Nombre coincida con el personaje del brief.`,
      ];
    }

    const variants = Math.min(4, Math.max(1, body.imageVariants ?? 1));
    return ok({ plan, estimate: estimateCost(plan, variants), model });
  } catch (err) {
    return serverError(err);
  }
}
