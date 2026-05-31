/**
 * Adaptador de video (Veo en Vertex AI), imagen->video.
 * Es una operacion de larga duracion (LRO): se lanza con :predictLongRunning y se
 * hace polling con :fetchPredictOperation hasta done.
 */
import { config, vertexBaseUrl, assertVertexConfig } from "../../config";
import type { VideoGenInput, VideoGenResult, VideoProvider } from "../types";
import { authHeaders, getAccessToken } from "./auth";

interface LroStart {
  name?: string;
}

interface LroPoll {
  done?: boolean;
  error?: { code?: number; message?: string };
  response?: {
    videos?: Array<{
      bytesBase64Encoded?: string;
      gcsUri?: string;
      mimeType?: string;
    }>;
    // algunas variantes devuelven generatedSamples
    generatedSamples?: Array<{
      video?: { uri?: string; encodedVideo?: string };
    }>;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class VertexVideoProvider implements VideoProvider {
  async generate(input: VideoGenInput): Promise<VideoGenResult> {
    assertVertexConfig();
    const model = config.models.video;
    const startUrl = `${vertexBaseUrl()}/${model}:predictLongRunning`;

    const prompt =
      input.dialogue && input.dialogue.trim().length > 0
        ? `${input.prompt}\nSpoken line (keep this exact language): "${input.dialogue}"`
        : input.prompt;

    const body = {
      instances: [
        {
          prompt,
          image: {
            bytesBase64Encoded: Buffer.from(input.imageBytes).toString("base64"),
            mimeType: input.imageMimeType ?? "image/png",
          },
        },
      ],
      parameters: {
        aspectRatio: input.aspectRatio ?? "9:16",
        durationSeconds: Math.max(1, Math.round(input.durationSec)),
        sampleCount: 1,
        // Veo 3 puede generar audio (incluido dialogo). TODO: confirmar soporte por modelo.
        generateAudio: Boolean(input.dialogue && input.dialogue.trim().length > 0),
      },
    };

    const startRes = await fetch(startUrl, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify(body),
    });
    if (!startRes.ok) {
      const t = await startRes.text();
      throw new Error(`Veo predictLongRunning fallo (${startRes.status}): ${t.slice(0, 500)}`);
    }
    const start = (await startRes.json()) as LroStart;
    if (!start.name) {
      throw new Error("Veo no devolvio el nombre de la operacion (LRO).");
    }

    return this.pollOperation(model, start.name);
  }

  private async pollOperation(
    model: string,
    operationName: string
  ): Promise<VideoGenResult> {
    const pollUrl = `${vertexBaseUrl()}/${model}:fetchPredictOperation`;
    const deadline = Date.now() + config.pipeline.veoPollTimeoutMs;

    while (Date.now() < deadline) {
      await sleep(config.pipeline.veoPollIntervalMs);
      const res = await fetch(pollUrl, {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({ operationName }),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`Veo fetchPredictOperation fallo (${res.status}): ${t.slice(0, 300)}`);
      }
      const poll = (await res.json()) as LroPoll;
      if (poll.error) {
        throw new Error(`Veo LRO error: ${poll.error.message ?? "desconocido"}`);
      }
      if (poll.done) {
        return this.extractVideo(poll);
      }
    }
    throw new Error(
      `Veo LRO timeout tras ${Math.round(config.pipeline.veoPollTimeoutMs / 1000)}s (operacion: ${operationName}).`
    );
  }

  private async extractVideo(poll: LroPoll): Promise<VideoGenResult> {
    const v = poll.response?.videos?.[0];
    if (v?.bytesBase64Encoded) {
      return {
        bytes: Buffer.from(v.bytesBase64Encoded, "base64"),
        mimeType: v.mimeType ?? "video/mp4",
      };
    }
    const sampleEncoded = poll.response?.generatedSamples?.[0]?.video?.encodedVideo;
    if (sampleEncoded) {
      return { bytes: Buffer.from(sampleEncoded, "base64"), mimeType: "video/mp4" };
    }
    const gcsUri = v?.gcsUri ?? poll.response?.generatedSamples?.[0]?.video?.uri;
    if (gcsUri) {
      const bytes = await downloadGcs(gcsUri);
      return { bytes, mimeType: v?.mimeType ?? "video/mp4", gcsUri };
    }
    throw new Error("Veo no devolvio video (ni bytes ni gcsUri).");
  }
}

/** Descarga un objeto gs://bucket/object usando el token ADC. */
async function downloadGcs(gsUri: string): Promise<Uint8Array> {
  const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(gsUri);
  if (!m) throw new Error(`gcsUri invalido: ${gsUri}`);
  const [, bucket, object] = m;
  const url = `https://storage.googleapis.com/download/storage/v1/b/${bucket}/o/${encodeURIComponent(
    object
  )}?alt=media`;
  const token = await getAccessToken();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`No se pudo descargar el video desde GCS (${res.status}): ${t.slice(0, 200)}`);
  }
  const ab = await res.arrayBuffer();
  return new Uint8Array(ab);
}
