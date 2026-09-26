/**
 * GET /api/config
 * Config no sensible para la UI: modo proveedor, catalogo de modelos, defaults,
 * carpeta de salida, si hay ffmpeg. NO expone credenciales.
 */
import { cookies } from "next/headers";
import {
  config,
  MODEL_CATALOG,
  VIDEO_RESOLUTIONS,
  DEFAULT_RESOLUTION,
} from "@/lib/config";
import { vertexCuentaFor } from "@/lib/cuentaVertex";
import { hasFfmpeg } from "@/lib/providers/placeholder";
import { ok } from "@/lib/http";
import { currentUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // El proyecto de la cuenta con la que genera QUIEN PREGUNTA (el suyo o el compartido),
  // no siempre el compartido. El path al JSON de credenciales no sale nunca.
  const cuenta = vertexCuentaFor(currentUser(cookies()));
  return ok({
    providerMode: config.providerMode,
    catalog: MODEL_CATALOG,
    defaults: config.models,
    defaultImageVariants: config.defaultImageVariants,
    resolutions: VIDEO_RESOLUTIONS,
    defaultResolution: DEFAULT_RESOLUTION,
    location: config.google.location,
    project: cuenta.proyecto || null,
    cuentaPropia: cuenta.usuario !== null,
    outputDir: config.storage.outputDir,
    dataDir: config.storage.dataDir,
    ffmpeg: hasFfmpeg(),
  });
}
