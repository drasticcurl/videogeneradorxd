/**
 * Estimacion de costo (ilustrativa) de un plan: imagenes * variantes + segundos de video.
 */
import { config } from "../../config";
import type { ProjectPlan } from "../../schema";

export function estimateCost(plan: ProjectPlan, imageVariants = 1) {
  const baseImages = plan.assets.reduce((acc, a) => acc + a.images.length, 0);
  const imageCount = baseImages * Math.max(1, imageVariants);
  const iaClips = plan.clips.filter((c) => c.etiqueta === "IA");
  const realClips = plan.clips.filter((c) => c.etiqueta === "FILMAR_REAL");
  const videoSeconds = iaClips.reduce((acc, c) => acc + c.duracion_seg, 0);

  const imageUsd = imageCount * config.pricing.imageUsd;
  const videoUsd = videoSeconds * config.pricing.videoPerSecUsd;
  const total = imageUsd + videoUsd;

  return {
    imageCount,
    baseImages,
    imageVariants: Math.max(1, imageVariants),
    videoCount: iaClips.length,
    realClipCount: realClips.length,
    videoSeconds,
    estimatedUsd: Number(total.toFixed(2)),
    breakdown: {
      imagesUsd: Number(imageUsd.toFixed(2)),
      videosUsd: Number(videoUsd.toFixed(2)),
    },
    providerMode: config.providerMode,
    note:
      config.providerMode === "mock"
        ? "PROVIDER_MODE=mock: no se gasta cuota ni dinero. La estimacion es solo ilustrativa."
        : "Estimacion aproximada; el costo real depende de los precios vigentes de Vertex AI.",
  };
}
