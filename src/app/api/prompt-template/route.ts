/**
 * GET /api/prompt-template
 *   -> { content, path, exists }  (texto de la plantilla del prompt de video)
 *
 * GET /api/prompt-template?download=1
 *   -> descarga el .md como adjunto (text/markdown).
 *
 * La plantilla vive en `prompts/veo-video-prompt.md`. La app la lee en runtime, asi
 * que editar ese archivo cambia los prompts que se le mandan a Veo sin recompilar.
 */
import type { NextRequest } from "next/server";
import { ok, serverError } from "@/lib/http";
import {
  loadVeoPromptTemplateText,
  veoPromptTemplateExists,
} from "@/lib/promptTemplate.server";
import { VEO_PROMPT_TEMPLATE_RELPATH } from "@/lib/promptTemplate";

export async function GET(req: NextRequest) {
  try {
    const text = loadVeoPromptTemplateText();
    const download = req.nextUrl.searchParams.get("download");
    if (download) {
      return new Response(text, {
        status: 200,
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": 'attachment; filename="veo-video-prompt.md"',
          "Cache-Control": "no-store",
        },
      });
    }
    return ok({
      content: text,
      path: VEO_PROMPT_TEMPLATE_RELPATH,
      exists: veoPromptTemplateExists(),
    });
  } catch (err) {
    return serverError(err);
  }
}
