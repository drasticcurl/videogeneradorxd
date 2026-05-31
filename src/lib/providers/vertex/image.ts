/**
 * Adaptador de imagen (Vertex AI).
 * - text2image: Imagen (:predict). Modelo configurable (IMAGE_MODEL).
 * - image2image / edicion con referencia: modelo de imagen de Gemini (IMAGE_EDIT_MODEL)
 *   via generateContent con inline_data, para MANTENER LA IDENTIDAD del avatar.
 */
import { config, vertexBaseUrl, assertVertexConfig } from "../../config";
import type { ImageGenInput, ImageGenResult, ImageProvider } from "../types";
import { authHeaders } from "./auth";

interface ImagenPredictResponse {
  predictions?: Array<{
    bytesBase64Encoded?: string;
    mimeType?: string;
  }>;
}

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
    if (input.refImageBytes) {
      return this.image2image(input);
    }
    return this.text2image(input);
  }

  /** Imagen :predict (text2image). */
  private async text2image(input: ImageGenInput): Promise<ImageGenResult> {
    const url = `${vertexBaseUrl()}/${config.models.image}:predict`;
    const body = {
      instances: [{ prompt: input.prompt }],
      parameters: {
        sampleCount: 1,
        aspectRatio: input.aspectRatio ?? "9:16",
        // TODO: confirmar - personGeneration permite generar adultos.
        personGeneration: "allow_adult",
        addWatermark: false,
        ...(input.negativePrompt
          ? { negativePrompt: input.negativePrompt }
          : {}),
      },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Imagen text2image fallo (${res.status}): ${t.slice(0, 500)}`);
    }
    const data = (await res.json()) as ImagenPredictResponse;
    const pred = data.predictions?.[0];
    if (!pred?.bytesBase64Encoded) {
      throw new Error("Imagen no devolvio bytes de imagen.");
    }
    return {
      bytes: toBytes(pred.bytesBase64Encoded),
      mimeType: pred.mimeType ?? "image/png",
    };
  }

  /** Gemini image model (image2image / edicion manteniendo identidad). */
  private async image2image(input: ImageGenInput): Promise<ImageGenResult> {
    const url = `${vertexBaseUrl()}/${config.models.imageEdit}:generateContent`;
    const refB64 = Buffer.from(input.refImageBytes!).toString("base64");
    const instruction =
      input.prompt +
      "\n\nIMPORTANT: keep identity 100% consistent with the reference image, " +
      "same face, same person. Only change what the instruction asks." +
      (input.negativePrompt ? `\nAvoid: ${input.negativePrompt}` : "");

    const body = {
      contents: [
        {
          role: "user",
          parts: [
            { text: instruction },
            {
              inlineData: {
                mimeType: input.refImageMimeType ?? "image/png",
                data: refB64,
              },
            },
          ],
        },
      ],
      generationConfig: {
        // El modelo de imagen de Gemini devuelve imagen como inlineData.
        responseModalities: ["IMAGE"],
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
        `Gemini image2image fallo (${res.status}): ${t.slice(0, 500)}`
      );
    }
    const data = (await res.json()) as GeminiImageResponse;
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    for (const p of parts) {
      const inline = p.inlineData ?? p.inline_data;
      if (inline?.data) {
        return {
          bytes: toBytes(inline.data),
          mimeType: inline.mimeType ?? "image/png",
        };
      }
    }
    throw new Error(
      "El modelo de imagen de Gemini no devolvio una imagen (inlineData)."
    );
  }
}
