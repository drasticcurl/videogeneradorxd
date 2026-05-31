/**
 * GET /api/config
 * Devuelve configuracion no sensible para mostrar en la UI (modo proveedor, modelos,
 * carpeta de salida, si hay ffmpeg). NO expone credenciales.
 */
import { config } from "@/lib/config";
import { hasFfmpeg } from "@/lib/providers/placeholder";
import { ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return ok({
    providerMode: config.providerMode,
    models: config.models,
    location: config.google.location,
    project: config.google.project || null,
    outputDir: config.storage.outputDir,
    dataDir: config.storage.dataDir,
    ffmpeg: hasFfmpeg(),
  });
}
