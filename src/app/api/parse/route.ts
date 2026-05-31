/**
 * POST /api/parse
 * Body: { brief: string, model?: string, imageVariants?: number }
 * Interpreta el brief con la LLM (Gemini en vertex / mock) y devuelve el PlanJSON
 * estructurado + validado, junto con la estimacion de costo. NO crea proyecto todavia.
 */
import { getLlmProvider } from "@/lib/providers";
import { estimateCost } from "@/lib/jobs/pipeline";
import { resolveModel } from "@/lib/config";
import { badRequest, ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      brief?: string;
      model?: string;
      imageVariants?: number;
    };
    const brief = (body.brief ?? "").trim();
    if (!brief) {
      return badRequest("El brief esta vacio. Pegá el texto con las escenas.");
    }
    const model = resolveModel("llm", body.model);
    const plan = await getLlmProvider().parseBrief(brief, { model });
    const variants = Math.min(4, Math.max(1, body.imageVariants ?? 1));
    return ok({ plan, estimate: estimateCost(plan, variants), model });
  } catch (err) {
    return serverError(err);
  }
}
