/**
 * Adaptador de video (Veo 3.1 en Vertex AI), imagen->video CON audio.
 * Es una operacion de larga duracion (LRO): se lanza con :predictLongRunning y se
 * hace polling con :fetchPredictOperation hasta done.
 *
 * Guardrails: aspect ratio 9:16 fijo y duracion snap a 4/6/8 (en el pipeline).
 */
import {
  config,
  vertexBaseUrl,
  assertVertexConfig,
  resolveModel,
  ASPECT_RATIO,
  snapDuration,
} from "../../config";
import { buildVeoVideoPrompt } from "../../prompts";
import type {
  VideoExtendInput,
  VideoGenInput,
  VideoGenResult,
  VideoProvider,
} from "../types";
import { ProviderHttpError, parseRetryAfter } from "../types";
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
    generatedSamples?: Array<{
      video?: { uri?: string; encodedVideo?: string };
    }>;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class VertexVideoProvider implements VideoProvider {
  async generate(input: VideoGenInput): Promise<VideoGenResult> {
    assertVertexConfig();
    const model = resolveModel("video", input.model);
    const startUrl = `${vertexBaseUrl()}/${model}:predictLongRunning`;

    // Prompt final con estilo UGC/selfie + acento rioplatense argentino (siempre que haya dialogo).
    const prompt = buildVeoVideoPrompt({
      videoPrompt: input.prompt,
      dialogue: input.dialogue,
      durationSec: input.durationSec,
      aspectRatio: input.aspectRatio ?? ASPECT_RATIO,
    });

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
        aspectRatio: input.aspectRatio ?? ASPECT_RATIO,
        durationSeconds: snapDuration(input.durationSec),
        sampleCount: 1,
        // Resolucion del video (720p / 1080p). TODO: confirmar soporte por modelo.
        resolution: input.resolution ?? "720p",
        // Veo 3.1 genera audio (incluido el dialogo). TODO: confirmar flag por modelo.
        generateAudio: true,
      },
    };

    const startRes = await fetch(startUrl, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify(body),
    });
    if (!startRes.ok) {
      const t = await startRes.text();
      throw new ProviderHttpError(
        `Veo (${model}) predictLongRunning fallo (${startRes.status}): ${t.slice(0, 500)}`,
        startRes.status,
        parseRetryAfter(startRes.headers.get("retry-after"))
      );
    }
    const start = (await startRes.json()) as LroStart;
    if (!start.name) {
      throw new Error("Veo no devolvio el nombre de la operacion (LRO).");
    }

    return this.pollOperation(model, start.name);
  }

  /**
   * Extiende un video ya generado (continuacion). Veo recibe el video base en
   * `instances[].video` y genera una continuacion de `durationSeconds` segundos.
   * La extension siempre es a 7s (lo fija el pipeline).
   */
  async extend(input: VideoExtendInput): Promise<VideoGenResult> {
    assertVertexConfig();
    const model = resolveModel("video", input.model);
    const startUrl = `${vertexBaseUrl()}/${model}:predictLongRunning`;

    const prompt = buildVeoVideoPrompt({
      videoPrompt:
        input.prompt +
        " Continue seamlessly from the provided video, keeping the same person, " +
        "wardrobe, lighting and setting consistent.",
      dialogue: input.dialogue,
      durationSec: input.durationSec,
      aspectRatio: input.aspectRatio ?? ASPECT_RATIO,
    });

    const body = {
      instances: [
        {
          prompt,
          // Video base a extender. TODO: confirmar shape exacto del campo segun version de Veo.
          video: {
            bytesBase64Encoded: Buffer.from(input.videoBytes).toString("base64"),
            mimeType: input.videoMimeType ?? "video/mp4",
          },
        },
      ],
      parameters: {
        aspectRatio: input.aspectRatio ?? ASPECT_RATIO,
        durationSeconds: Math.round(input.durationSec),
        sampleCount: 1,
        resolution: input.resolution ?? "720p",
        generateAudio: true,
      },
    };

    const startRes = await fetch(startUrl, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify(body),
    });
    if (!startRes.ok) {
      const t = await startRes.text();
      throw new ProviderHttpError(
        `Veo (${model}) extend/predictLongRunning fallo (${startRes.status}): ${t.slice(0, 500)}`,
        startRes.status,
        parseRetryAfter(startRes.headers.get("retry-after"))
      );
    }
    const start = (await startRes.json()) as LroStart;
    if (!start.name) {
      throw new Error("Veo no devolvio el nombre de la operacion (LRO) al extender.");
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
        throw new ProviderHttpError(
          `Veo fetchPredictOperation fallo (${res.status}): ${t.slice(0, 300)}`,
          res.status,
          parseRetryAfter(res.headers.get("retry-after"))
        );
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
      `Veo LRO timeout tras ${Math.round(
        config.pipeline.veoPollTimeoutMs / 1000
      )}s (operacion: ${operationName}).`
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
    throw new Error(
      `No se pudo descargar el video desde GCS (${res.status}): ${t.slice(0, 200)}`
    );
  }
  const ab = await res.arrayBuffer();
  return new Uint8Array(ab);
}
