/**
 * POST /api/parse
 * Body: { brief: string }
 * Interpreta el brief con la LLM (Gemini en vertex / mock) y devuelve el PlanJSON
 * estructurado + validado, junto con la estimacion de costo. NO crea proyecto todavia.
 */
import { getLlmProvider } from "@/lib/providers";
import { estimateCost } from "@/lib/jobs/pipeline";
import { badRequest, ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { brief?: string };
    const brief = (body.brief ?? "").trim();
    if (!brief) {
      return badRequest("El brief esta vacio. Pegá el texto con las escenas.");
    }
    const plan = await getLlmProvider().parseBrief(brief);
    return ok({ plan, estimate: estimateCost(plan) });
  } catch (err) {
    return serverError(err);
  }
}
