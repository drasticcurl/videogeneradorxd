/**
 * Factory de proveedores. Selecciona mock o vertex segun PROVIDER_MODE.
 * El resto de la app solo conoce las interfaces (types.ts), nunca los adaptadores.
 */
import { config } from "../config";
import type { ImageProvider, LlmProvider, Providers, VideoProvider } from "./types";
import {
  MockImageProvider,
  MockLlmProvider,
  MockVideoProvider,
} from "./mock";
import { VertexLlmProvider } from "./vertex/llm";
import { VertexImageProvider } from "./vertex/image";
import { VertexVideoProvider } from "./vertex/video";

let cached: Providers | null = null;

export function getProviders(): Providers {
  if (cached) return cached;
  if (config.providerMode === "vertex") {
    cached = {
      llm: new VertexLlmProvider(),
      image: new VertexImageProvider(),
      video: new VertexVideoProvider(),
    };
  } else {
    cached = {
      llm: new MockLlmProvider(),
      image: new MockImageProvider(),
      video: new MockVideoProvider(),
    };
  }
  return cached;
}

export function getLlmProvider(): LlmProvider {
  return getProviders().llm;
}
export function getImageProvider(): ImageProvider {
  return getProviders().image;
}
export function getVideoProvider(): VideoProvider {
  return getProviders().video;
}

export type { Providers, LlmProvider, ImageProvider, VideoProvider };
