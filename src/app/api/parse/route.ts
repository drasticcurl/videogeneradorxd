/**
 * POST /api/parse
 * Body: { brief: string, model?: string, imageVariants?: number }
 * Interpreta el brief con la LLM (Gemini en vertex / mock) y devuelve el PlanJSON
 * estructurado + validado, junto con la estimacion de costo. NO crea proyecto todavia.
 */
import { getLlmProvider } from "@/lib/providers";
import { estimateCost } from "@/lib/jobs/pipeline";
import { resolveModel } from "@/lib/config";
import { slugify } from "@/lib/storage";
import { badRequest, ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
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

    const variants = Math.min(4, Math.max(1, body.imageVariants ?? 1));
    return ok({ plan, estimate: estimateCost(plan, variants), model });
  } catch (err) {
    return serverError(err);
  }
}
