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
    const isEdit = Boolean(input.refImageBytes);

    const instruction = isEdit
      ? input.prompt +
        "\n\nIMPORTANT: keep identity 100% consistent with the reference image, " +
        "same face, same person. Only change what the instruction asks. " +
        `Output a single vertical ${aspect} image.` +
        (input.negativePrompt ? `\nAvoid: ${input.negativePrompt}` : "")
      : input.prompt +
        `\n\nOutput a single photorealistic vertical ${aspect} image.` +
        (input.negativePrompt ? `\nAvoid: ${input.negativePrompt}` : "");

    const parts: Array<Record<string, unknown>> = [{ text: instruction }];
    if (isEdit) {
      parts.push({
        inlineData: {
          mimeType: input.refImageMimeType ?? "image/png",
          data: Buffer.from(input.refImageBytes!).toString("base64"),
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
      throw new Error(
        `Nano Banana (${model}) ${isEdit ? "image2image" : "text2image"} fallo (${res.status}): ${t.slice(0, 500)}`
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
