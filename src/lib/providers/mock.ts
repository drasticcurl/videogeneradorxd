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
  VideoExtendInput,
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
    references: [],
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

/**
 * Demo VSL (talking-head) cuando el usuario sube avatares de referencia.
 * Cada referencia se vuelve un asset cuya imagen base es image2image contra la foto
 * subida (misma identidad), mas un plano alternativo (primer plano), y un par de clips
 * con dialogo rioplatense. Sirve para probar el flujo VSL de punta a punta en mock.
 */
function vslDemoPlan(
  brief: string,
  refs: { id: string; label?: string }[]
): ProjectPlan {
  const excerpt = brief.trim().slice(0, 120).replace(/\s+/g, " ");
  const assets: ProjectPlan["assets"] = [];
  const clips: ProjectPlan["clips"] = [];
  let orden = 1;

  refs.forEach((ref, i) => {
    const baseId = `${ref.id}_base`;
    const cuId = `${ref.id}_closeup`;
    const name = ref.label || ref.id;
    assets.push({
      id: ref.id,
      tipo: "avatar",
      images: [
        {
          id: baseId,
          modo: "image2image",
          ref_image_id: ref.id, // <- foto subida (reference)
          prompt:
            `Studio-quality medium close-up portrait of the SAME person as the reference photo (${name}), ` +
            "keep identity 100% consistent with the reference, same face, same person, " +
            "light blouse, seated talking to camera in a bright modern office, softly blurred background, " +
            "soft natural daylight, shallow depth of field, photorealistic, 9:16.",
          negative_prompt: DEFAULT_NEGATIVE,
        },
        {
          id: cuId,
          modo: "image2image",
          ref_image_id: baseId,
          prompt:
            "Same person, keep identity 100% consistent with the reference, same face, same person, " +
            "tighter close-up framing, warm confident expression, same wardrobe and set, 9:16.",
          negative_prompt: DEFAULT_NEGATIVE,
        },
      ],
    });

    clips.push({
      id: `${ref.id}_intro`,
      orden: orden++,
      asset_id: ref.id,
      image_id: baseId,
      video_prompt:
        "Medium close-up, talking head, the person talks directly to camera, natural head and hand motion, accurate lip-sync.",
      dialogo:
        i === 0
          ? "Hola, soy la licenciada. Estás en el lugar correcto, quedate conmigo."
          : "Hola Naty, no pensé que iba a funcionar tan rápido, te cuento mi caso.",
      duracion_seg: 8,
      etiqueta: "IA",
    });
    clips.push({
      id: `${ref.id}_punch`,
      orden: orden++,
      asset_id: ref.id,
      image_id: cuId,
      video_prompt:
        "Close-up, the person leans in slightly with a warm confident expression, talking to camera, accurate lip-sync.",
      dialogo:
        i === 0
          ? "Hoy es el primer día de tu nueva vida. Acá es donde todo empieza."
          : "En unas semanas se me desinfló la panza y se me fue la ansiedad de la noche.",
      duracion_seg: 8,
      etiqueta: "IA",
    });
  });

  return {
    global: {
      idioma_dialogo: "es-AR",
      formato: "9:16",
      reglas_realismo:
        "Talking head profesional pero cercano, luz natural suave, piel con textura real, misma cara/ropa/set en todos los planos.",
      negative_prompt: DEFAULT_NEGATIVE,
    },
    references: refs.map((r) => ({ id: r.id, label: r.label })),
    assets,
    clips,
    warnings: [
      "Plan VSL generado por el MOCK provider (PROVIDER_MODE=mock): demo para probar el flujo de avatares de referencia de punta a punta.",
      `Avatares de referencia: ${refs.map((r) => r.label || r.id).join(", ")}.`,
      `Brief recibido (extracto): "${excerpt}..."`,
    ],
  };
}

export class MockLlmProvider implements LlmProvider {
  async parseBrief(
    _text: string,
    _opts?: { model?: string; references?: { id: string; label?: string }[] }
  ): Promise<ProjectPlan> {
    // Simulamos latencia de la LLM.
    await new Promise((r) => setTimeout(r, 300));
    const refs = _opts?.references ?? [];
    if (refs.length > 0) return vslDemoPlan(_text, refs);
    return demoPlan(_text);
  }
}

export class MockImageProvider implements ImageProvider {
  async generate(input: ImageGenInput): Promise<ImageGenResult> {
    await new Promise((r) => setTimeout(r, 400));
    // Incluimos un nonce para que cada variante/regeneracion salga distinta.
    const nonce = Math.random().toString(36).slice(2, 8);
    const refCount =
      (input.refImages?.length ?? 0) + (input.refImageBytes ? 1 : 0);
    const seed =
      (refCount > 0 ? `i2i${refCount}:` : "t2i:") +
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

  async extend(input: VideoExtendInput): Promise<VideoGenResult> {
    await new Promise((r) => setTimeout(r, 800));
    // En mock devolvemos un placeholder de la duracion de la extension.
    const bytes = makeMp4Placeholder(
      "extend:" + (input.model ?? "") + ":" + input.prompt,
      input.durationSec,
      input.aspectRatio ?? "9:16"
    );
    return { bytes, mimeType: "video/mp4" };
  }
}
