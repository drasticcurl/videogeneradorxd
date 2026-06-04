/**
 * POST /api/transcribe
 * Transcribe LOCALMENTE un clip (video o audio) a texto usando Whisper (sin API).
 * Form-data: { file: File }
 * Devuelve: { text, model, language, durationMs, savedTo }
 *
 * Una request = un archivo (la UI los manda de a uno, en cola, para no saturar la CPU).
 */
import { transcribeFile } from "@/lib/transcribe";
import { badRequest, ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Whisper puede tardar (sobre todo en CPU con `small`). En self-host de Next esto
// no impone limite real; queda como hint para entornos serverless.
export const maxDuration = 3600;

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");

    if (!(file instanceof File)) return badRequest("Falta el archivo (file).");
    if (file.size === 0) return badRequest("El archivo esta vacio.");

    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await transcribeFile(file.name || "clip", bytes);

    return ok({
      text: result.text,
      model: result.model,
      language: result.language,
      durationMs: result.durationMs,
      savedTo: result.txtPath,
    });
  } catch (err) {
    return serverError(err);
  }
}
