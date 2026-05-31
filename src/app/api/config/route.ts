/**
 * GET /api/config
 * Config no sensible para la UI: modo proveedor, catalogo de modelos, defaults,
 * carpeta de salida, si hay ffmpeg. NO expone credenciales.
 */
import { config, MODEL_CATALOG } from "@/lib/config";
import { hasFfmpeg } from "@/lib/providers/placeholder";
import { ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return ok({
    providerMode: config.providerMode,
    catalog: MODEL_CATALOG,
    defaults: config.models,
    defaultImageVariants: config.defaultImageVariants,
    location: config.google.location,
    project: config.google.project || null,
    outputDir: config.storage.outputDir,
    dataDir: config.storage.dataDir,
    ffmpeg: hasFfmpeg(),
  });
}
