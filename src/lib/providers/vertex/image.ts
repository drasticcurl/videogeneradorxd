/**
 * Adaptador de imagen (Vertex AI) usando SOLO Nano Banana (modelo de imagen de Gemini).
 *
 * El MISMO modelo hace text2image (sin referencia) e image2image (con referencia,
 * manteniendo la identidad del avatar) via generateContent. El modelo concreto
 * (gemini-3.1-flash-image / gemini-3-pro-image) llega por input.model.
 */
import {
  vertexBaseUrl,
  assertVertexConfig,
  resolveModel,
  ASPECT_RATIO,
} from "../../config";
import type { ImageGenInput, ImageGenResult, ImageProvider } from "../types";
import { ProviderHttpError, parseRetryAfter } from "../types";
import { authHeaders } from "./auth";

interface GeminiImageResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: { mimeType?: string; data?: string };
        inline_data?: { mimeType?: string; data?: string };
      }>;
    };
  }>;
}

function toBytes(b64: string): Uint8Array {
  return Buffer.from(b64, "base64");
}

export class VertexImageProvider implements ImageProvider {
  async generate(input: ImageGenInput): Promise<ImageGenResult> {
    assertVertexConfig();
    const model = resolveModel("image", input.model);
    const url = `${vertexBaseUrl()}/${model}:generateContent`;

    const aspect = input.aspectRatio ?? ASPECT_RATIO;

    // Reunimos las imagenes de referencia: refImages (multiple) tiene prioridad,
    // si no, caemos a refImageBytes (single) por compatibilidad.
    const refs =
      input.refImages && input.refImages.length > 0
        ? input.refImages
        : input.refImageBytes
        ? [{ bytes: input.refImageBytes, mimeType: input.refImageMimeType }]
        : [];
    const isEdit = refs.length > 0;
    const multi = refs.length > 1;

    const identityLine = multi
      ? "IMPORTANT: keep EACH person's identity 100% consistent with their reference photo " +
        "(same faces, same people). Combine them naturally in one shot. " +
        "Only change what the instruction asks (pose, framing, wardrobe context). "
      : "IMPORTANT: keep identity 100% consistent with the reference image, " +
        "same face, same person. Only change what the instruction asks. ";

    const instruction = isEdit
      ? input.prompt +
        "\n\n" +
        identityLine +
        `Output a single vertical ${aspect} image.` +
        (input.negativePrompt ? `\nAvoid: ${input.negativePrompt}` : "")
      : input.prompt +
        `\n\nOutput a single photorealistic vertical ${aspect} image.` +
        (input.negativePrompt ? `\nAvoid: ${input.negativePrompt}` : "");

    const parts: Array<Record<string, unknown>> = [{ text: instruction }];
    for (const ref of refs) {
      parts.push({
        inlineData: {
          mimeType: ref.mimeType ?? "image/png",
          data: Buffer.from(ref.bytes).toString("base64"),
        },
      });
    }

    const body = {
      contents: [{ role: "user", parts }],
      generationConfig: {
        // El modelo de imagen de Gemini devuelve la imagen como inlineData.
        responseModalities: ["IMAGE"],
        // TODO: confirmar - algunos modelos aceptan imageConfig.aspectRatio.
        imageConfig: { aspectRatio: aspect },
      },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new ProviderHttpError(
        `Nano Banana (${model}) ${isEdit ? "image2image" : "text2image"} fallo (${res.status}): ${t.slice(0, 500)}`,
        res.status,
        parseRetryAfter(res.headers.get("retry-after"))
      );
    }
    const data = (await res.json()) as GeminiImageResponse;
    const candParts = data.candidates?.[0]?.content?.parts ?? [];
    for (const p of candParts) {
      const inline = p.inlineData ?? p.inline_data;
      if (inline?.data) {
        return {
          bytes: toBytes(inline.data),
          mimeType: inline.mimeType ?? "image/png",
        };
      }
    }
    throw new Error(
      `El modelo de imagen (${model}) no devolvio una imagen (inlineData).`
    );
  }
}
