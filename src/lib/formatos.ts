/**
 * Formatos y calidades de imagen. Modulo PURO a proposito.
 *
 * Vive aparte de `config.ts` porque esto lo necesita el CLIENTE (el selector de la
 * pantalla de imagenes) y `config.ts` importa `node:path` y lee `AUTH_SECRET` y
 * `PASSWORD_*`. Importarlo desde un componente de cliente arrastraria todo eso al
 * bundle del browser. Aca no hay ni un import ni una lectura de environment, asi que
 * lo puede usar cualquiera de los dos lados.
 *
 * `config.ts` re-exporta todo esto, para que el server siga teniendo un solo lugar
 * donde mirar.
 */

/** Formato por DEFECTO: vertical 9:16, que es el del flujo de VSL. */
export const ASPECT_RATIO = "9:16";

export type Orientacion = "vertical" | "cuadrado" | "horizontal";

export interface FormatoImagen {
  /** lo que se manda en imageConfig.aspectRatio */
  id: string;
  /** proporciones para DIBUJAR la forma en la UI (no son pixeles) */
  w: number;
  h: number;
  orientacion: Orientacion;
  /** para que se suele usar, como ayuda al elegir */
  uso?: string;
}

/**
 * Los 10 formatos que acepta `imageConfig.aspectRatio`.
 *
 * Fuente: referencia oficial de Vertex AI V1, clase ImageConfig, campo aspect_ratio
 * (cloud.google.com/ruby/docs/reference/google-cloud-ai_platform-v1 → ImageConfig).
 * Verificado ademas contra la API real: se pidio 16:9 y volvio 1376x768 (ratio 1.792),
 * y se pidio 4:5 y volvio 1856x2304 (ratio 0.806). O sea que el parametro no se ignora,
 * se respeta.
 *
 * El orden es a proposito: primero verticales, despues cuadrado, despues horizontales.
 * La UI los agrupa asi porque la pregunta al elegir es "¿esto es vertical u
 * horizontal?" antes que "¿cuanto mide?".
 */
export const IMAGE_ASPECT_RATIOS: readonly FormatoImagen[] = [
  { id: "9:16", w: 9, h: 16, orientacion: "vertical", uso: "Reels, TikTok, historias" },
  { id: "2:3", w: 2, h: 3, orientacion: "vertical", uso: "Foto vertical, print" },
  { id: "3:4", w: 3, h: 4, orientacion: "vertical", uso: "Feed vertical" },
  { id: "4:5", w: 4, h: 5, orientacion: "vertical", uso: "Feed de Instagram" },
  { id: "1:1", w: 1, h: 1, orientacion: "cuadrado", uso: "Cuadrado clasico" },
  { id: "5:4", w: 5, h: 4, orientacion: "horizontal", uso: "Casi cuadrado" },
  { id: "4:3", w: 4, h: 3, orientacion: "horizontal", uso: "Foto horizontal" },
  { id: "3:2", w: 3, h: 2, orientacion: "horizontal", uso: "Foto horizontal ancha" },
  { id: "16:9", w: 16, h: 9, orientacion: "horizontal", uso: "YouTube, pantalla" },
  { id: "21:9", w: 21, h: 9, orientacion: "horizontal", uso: "Ultra ancho, cine" },
] as const;

export function resolveAspectRatio(value?: string): string {
  return IMAGE_ASPECT_RATIOS.some((f) => f.id === value)
    ? (value as string)
    : ASPECT_RATIO;
}

/**
 * Calidad de la imagen: `imageConfig.imageSize`. Default de la API si no se manda: 1K.
 *
 * Los pixeles NO son 1024/2048/4096: es un escalon, y el tamaño real sale de combinar
 * el escalon con el formato. Medido contra la API:
 *   1K + 16:9 -> 1376x768   (~1.1 MB)
 *   2K + 4:5  -> 1856x2304  (~4.6 MB)
 *   4K + 16:9 -> 5504x3072  (~15 MB)
 */
export const IMAGE_SIZES = ["1K", "2K", "4K"] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];

/**
 * Modelos que SOLO aceptan 1K.
 *
 * No es una precaucion: `gemini-3.1-flash-lite-image` con imageSize "2K" devuelve
 * 400 "Request contains an invalid argument" (probado contra la API real el
 * 2026-08-28). Con "1K" explicito anda y devuelve 1376x768 de ~52 KB. 4K no se probo
 * en el lite, se asume rechazado por ser mas grande que 2K.
 *
 * Importa que la UI lo respete: si se deja elegir 2K con el lite, el job sale 400,
 * se come los reintentos y el usuario ve un fallo sin entender por que.
 */
export const IMAGE_MODELS_SOLO_1K: readonly string[] = [
  "gemini-3.1-flash-lite-image",
];

/** Calidades disponibles para un modelo de imagen. */
export function imageSizesFor(model?: string): readonly ImageSize[] {
  if (model && IMAGE_MODELS_SOLO_1K.includes(model)) return ["1K"];
  return IMAGE_SIZES;
}

/** Normaliza la calidad pedida, recortandola a lo que el modelo soporta. */
export function resolveImageSize(value?: string, model?: string): ImageSize {
  const permitidas = imageSizesFor(model);
  return permitidas.includes(value as ImageSize) ? (value as ImageSize) : "1K";
}
