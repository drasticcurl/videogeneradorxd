/**
 * MOCK provider: NO usa credenciales ni cuota. Permite probar el pipeline COMPLETO.
 * - parseBrief: devuelve un PlanJSON demo realista (avatar text2image + image2image,
 *   un b-roll, y clips hook/reveal/escepticismo/mecanismo/warning/CTA, con un FILMAR_REAL).
 * - image/video.generate: devuelven placeholders generados localmente.
 */
import type {
  ImageGenInput,
  ImageGenResult,
  ImageProvider,
  LlmProvider,
  VideoGenInput,
  VideoGenResult,
  VideoProvider,
} from "./types";
import type { ProjectPlan } from "../schema";
import { makeMp4Placeholder, makePngPlaceholder } from "./placeholder";

const DEFAULT_NEGATIVE =
  "blurry, deformed hands, extra fingers, text artifacts, watermark, low quality, plastic skin, oversaturated";

function demoPlan(brief: string): ProjectPlan {
  const excerpt = brief.trim().slice(0, 120).replace(/\s+/g, " ");
  return {
    global: {
      idioma_dialogo: "es-AR",
      formato: "9:16",
      reglas_realismo:
        "Realismo documental, luz natural de cocina, piel con textura real, sin retoque excesivo.",
      negative_prompt: DEFAULT_NEGATIVE,
    },
    assets: [
      {
        id: "avatar1",
        tipo: "avatar",
        images: [
          {
            id: "avatar1_base",
            modo: "text2image",
            prompt:
              "Photorealistic portrait of an Argentine woman around 40 years old, slightly overweight, " +
              "standing in a humble home kitchen, holding a glass of rice water, natural daylight, candid documentary style, 9:16.",
            negative_prompt: DEFAULT_NEGATIVE,
          },
          {
            id: "avatar1_desinflada",
            modo: "image2image",
            ref_image_id: "avatar1_base",
            prompt:
              "Same woman, keep identity 100% consistent with the reference, same face, same person, " +
              "now looking slimmer and more deflated, wearing a burgundy dress, standing in front of a mirror, natural light, 9:16.",
            negative_prompt: DEFAULT_NEGATIVE,
          },
        ],
      },
      {
        id: "broll_vaso",
        tipo: "broll",
        images: [
          {
            id: "broll_vaso_base",
            modo: "text2image",
            prompt:
              "Close-up b-roll of a glass of cloudy rice water on a wooden kitchen counter, soft natural light, shallow depth of field, 9:16.",
            negative_prompt: DEFAULT_NEGATIVE,
          },
        ],
      },
    ],
    clips: [
      {
        id: "hook",
        orden: 1,
        asset_id: "avatar1",
        image_id: "avatar1_base",
        video_prompt:
          "Handheld selfie style, woman talks directly to camera in the kitchen, slight zoom in, natural light.",
        dialogo: "Pará dos segundos: esto me cambió la panza en serio.",
        duracion_seg: 8,
        etiqueta: "IA",
        on_screen_text: "Pará 2 segundos 👀",
      },
      {
        id: "reveal",
        orden: 2,
        asset_id: "avatar1",
        image_id: "avatar1_desinflada",
        video_prompt:
          "Woman in burgundy dress turns in front of the mirror showing a flatter belly, confident smile, soft light.",
        dialogo: "Mirá cómo me quedó después de tomarlo todas las mañanas.",
        duracion_seg: 8,
        etiqueta: "IA",
        on_screen_text: "El antes y el después",
      },
      {
        id: "escepticismo",
        orden: 3,
        asset_id: "avatar1",
        image_id: "avatar1_base",
        video_prompt:
          "Woman shrugs skeptically, raises an eyebrow, talking to camera, kitchen background.",
        dialogo: "Yo también pensaba que era otro verso, te juro.",
        duracion_seg: 8,
        etiqueta: "IA",
      },
      {
        id: "mecanismo",
        orden: 4,
        asset_id: "broll_vaso",
        image_id: "broll_vaso_base",
        video_prompt:
          "Macro shot of rice water being stirred in a glass, slow motion, light catching the liquid.",
        dialogo: "El agua de arroz ayuda a desinflar y a sentirte liviana.",
        duracion_seg: 8,
        etiqueta: "IA",
        on_screen_text: "Agua de arroz",
      },
      {
        id: "warning",
        orden: 5,
        asset_id: "avatar1",
        image_id: "avatar1_base",
        video_prompt:
          "Woman points finger at camera with a serious but friendly expression, kitchen background.",
        dialogo: "Ojo: no lo tomes de cualquier forma, hay un truco.",
        duracion_seg: 8,
        etiqueta: "FILMAR_REAL",
        on_screen_text: "⚠️ Importante",
      },
      {
        id: "cta",
        orden: 6,
        asset_id: "avatar1",
        image_id: "avatar1_desinflada",
        video_prompt:
          "Woman smiles and gestures inviting the viewer to tap, pointing down, bright friendly mood.",
        dialogo: "Hacé el quiz de 30 segundos y te digo cómo arrancar.",
        duracion_seg: 8,
        etiqueta: "IA",
        on_screen_text: "Hacé el quiz 👇",
      },
    ],
    warnings: [
      "Plan generado por el MOCK provider (PROVIDER_MODE=mock): no refleja el contenido real del brief, es un demo para probar el pipeline de punta a punta.",
      `Brief recibido (extracto): "${excerpt}..."`,
    ],
  };
}

export class MockLlmProvider implements LlmProvider {
  async parseBrief(_text: string, _opts?: { model?: string }): Promise<ProjectPlan> {
    // Simulamos latencia de la LLM.
    await new Promise((r) => setTimeout(r, 300));
    return demoPlan(_text);
  }
}

export class MockImageProvider implements ImageProvider {
  async generate(input: ImageGenInput): Promise<ImageGenResult> {
    await new Promise((r) => setTimeout(r, 400));
    // Incluimos un nonce para que cada variante/regeneracion salga distinta.
    const nonce = Math.random().toString(36).slice(2, 8);
    const seed =
      (input.refImageBytes ? "i2i:" : "t2i:") +
      (input.model ?? "") +
      ":" +
      input.prompt +
      ":" +
      nonce;
    const bytes = makePngPlaceholder(seed, input.aspectRatio ?? "9:16");
    return { bytes, mimeType: "image/png" };
  }
}

export class MockVideoProvider implements VideoProvider {
  async generate(input: VideoGenInput): Promise<VideoGenResult> {
    await new Promise((r) => setTimeout(r, 800));
    const bytes = makeMp4Placeholder(
      (input.model ?? "") + ":" + input.prompt,
      input.durationSec,
      input.aspectRatio ?? "9:16"
    );
    return { bytes, mimeType: "video/mp4" };
  }
}
