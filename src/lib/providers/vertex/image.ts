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
  resolveImageSize,
  ASPECT_RATIO,
  config,
} from "../../config";
import type { ImageGenInput, ImageGenResult, ImageProvider } from "../types";
import { ProviderHttpError, parseRetryAfter } from "../types";
import { buildImageInstruction } from "../../prompts";
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

    // Instruccion compartida con el preview (mismo texto que se ejecuta).
    const instruction = buildImageInstruction({
      prompt: input.prompt,
      refCount: refs.length,
      aspectRatio: aspect,
      negativePrompt: input.negativePrompt,
    });

    const parts: Array<Record<string, unknown>> = [{ text: instruction }];
    for (const ref of refs) {
      parts.push({
        inlineData: {
          mimeType: ref.mimeType ?? "image/png",
          data: Buffer.from(ref.bytes).toString("base64"),
        },
      });
    }

    /*
      Calidad. Se recorta a lo que el modelo soporta ANTES de mandarla: el lite
      contesta 400 "Request contains an invalid argument" con "2K" (probado contra la
      API real), y un 400 se come reintentos de la cola y aparece como una falla
      cualquiera. Mejor pedir 1K y que salga.
    */
    const size = resolveImageSize(input.imageSize, model);

    const body = {
      contents: [{ role: "user", parts }],
      generationConfig: {
        // El modelo de imagen de Gemini devuelve la imagen como inlineData.
        responseModalities: ["IMAGE"],
        /*
          Verificado contra la API real (2026-08-28), ya no es un TODO: los dos campos
          se respetan y no se ignoran. Se pidio 16:9 + 1K y volvio 1376x768; 4:5 + 2K
          y volvio 1856x2304; 16:9 + 4K y volvio 5504x3072. El ratio de lo que vuelve
          coincide con el pedido en los tres casos.
        */
        imageConfig: { aspectRatio: aspect, imageSize: size },
      },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify(body),
      // Si la conexion se cuelga, abortamos y dejamos que la cola reintente
      // (en vez de bloquear un slot de concurrencia para siempre).
      signal: AbortSignal.timeout(config.pipeline.imageTimeoutMs),
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
