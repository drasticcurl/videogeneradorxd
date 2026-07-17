// Contrato de `inputProps` compartido entre el backend Python
// (backend/app/engine/remotion.py -> construir_props) y la composicion Remotion.
//
// IMPORTANTE: existen DOS copias de este archivo que DEBEN quedar IDENTICAS
// (byte a byte) entre si:
//   - remotion/src/types.ts               (render SSR con Node)
//   - frontend/components/remotion/types.ts (navegador con @remotion/player)
// La composicion se renderiza tanto en SSR como en el navegador y ambas
// necesitan el mismo contrato de props. La UNICA diferencia permitida entre las
// dos copias de la composicion es el subcomponente `FondoVideo`
// (`OffthreadVideo` en SSR vs `Video` en el navegador), que NO vive en este
// archivo; por tanto `types.ts` debe ser identico en ambos lugares.
//
// La forma de estos tipos debe coincidir EXACTAMENTE con el `props.json` que
// serializa Python. Cualquier cambio aqui debe reflejarse en la otra copia y en
// `backend/app/engine/remotion.py` (construir_props).
//
// Nota: ya NO dependemos de `Caption` de @remotion/captions para el render.
// El backend ahora envia los subtitulos agrupados en `grupos` (frases), cada
// uno con sus palabras opcionales con timing. El paquete @remotion/captions
// puede seguir instalado, pero la composicion trabaja con `grupos`.

/** Una palabra con su timing en milisegundos (para el resaltado karaoke). */
export type Palabra = {
  /** Texto de la palabra (sin espacios). */
  text: string;
  /** Milisegundo de inicio de la palabra. */
  startMs: number;
  /** Milisegundo de fin de la palabra. */
  endMs: number;
};

/**
 * Un grupo es una frase/subtitulo que se muestra completo a la vez.
 * `words` puede venir vacio: en ese caso se divide `text` por espacios y se
 * muestra sin resaltado palabra-por-palabra.
 */
export type Grupo = {
  /** Texto completo del grupo (frase). */
  text: string;
  /** Milisegundo de inicio del grupo (cuando aparece). */
  startMs: number;
  /** Milisegundo de fin del grupo (cuando desaparece). */
  endMs: number;
  /** Palabras con timing; puede estar vacio. */
  words: Palabra[];
};

/** Estilo visual de los subtitulos (mapeado desde AjustesSubtitulos en Python). */
export type Estilo = {
  /** Familia tipografica (p. ej. "Inter", "Arial"). */
  fuente: string;
  /** Tamano de fuente en pixeles. */
  tamano: number;
  /** Color base del texto en formato #RRGGBB. */
  color: string;
  /** Color de la palabra actualmente resaltada, en formato #RRGGBB. */
  colorResaltado: string;
  /** Posicion vertical del bloque de subtitulos, en porcentaje 0..100 (0 arriba, 100 abajo). */
  posVerticalPct: number;
  /** Duracion de la animacion de entrada de cada grupo, en milisegundos. */
  animEntradaMs: number;
  /** Color del borde/outline del texto en formato #RRGGBB. */
  colorBorde: string;
  /** Grosor del borde/outline del texto en pixeles (0 => sin borde). */
  grosorBorde: number;
  /** Si el texto se muestra en negrita (700) o normal (400). */
  negrita: boolean;
};

/**
 * Estilo visual de un texto extra tipo "hook" (NUEVO, aditivo).
 *
 * Es INDEPENDIENTE del estilo de los subtitulos (`Estilo`) aunque comparte los
 * mismos tipos de campo. Se expresa en camelCase para coincidir con el
 * `props.json` que serializa el backend (mismo criterio que `Estilo`).
 */
export type EstiloTextoExtra = {
  /** Familia tipografica (p. ej. "Inter", "Arial"). */
  fuente: string;
  /** Tamano de fuente en pixeles (rango del motor 12..200). */
  tamano: number;
  /** Color de relleno del texto en formato #RRGGBB. */
  color: string;
  /** Color del borde/outline del texto en formato #RRGGBB. */
  colorBorde: string;
  /** Grosor del borde/outline del texto en pixeles (0 => sin borde). */
  grosorBorde: number;
  /** Si el texto se muestra en negrita (700) o normal (400). */
  negrita: boolean;
  /** Posicion vertical, en porcentaje 0..100 (0 arriba, 100 abajo). */
  posVerticalPct: number;
  /** Posicion horizontal, en porcentaje 0..100 (0 izquierda, 100 derecha). */
  posHorizontalPct: number;
};

/**
 * Overlay de texto plano SIN animacion (NUEVO, aditivo).
 *
 * Se muestra unicamente en el intervalo [inicioMs, finMs) sobre el video final,
 * con su estilo independiente. Los tiempos estan en milisegundos (mismo
 * criterio de conversion segundos->ms que el resto del contrato).
 */
export type TextoExtraProps = {
  /** Texto plano a mostrar. */
  texto: string;
  /** Milisegundo de entrada (in) del texto. */
  inicioMs: number;
  /** Milisegundo de salida (out) del texto. */
  finMs: number;
  /** Estilo independiente del texto extra. */
  estilo: EstiloTextoExtra;
};

/** Propiedades de entrada de la composicion `ShortVideo`. */
export type ShortVideoProps = {
  /**
   * URL http del video de fondo ya cortado. Si es "" o null => fondo blanco
   * (modo playground).
   */
  videoSrc: string;
  /** Cuadros por segundo del render. */
  fps: number;
  /** Ancho del video en pixeles. */
  width: number;
  /** Alto del video en pixeles. */
  height: number;
  /** Duracion total en frames (derivada de la duracion del video * fps). */
  durationInFrames: number;
  /** Estilo visual de los subtitulos. */
  estilo: Estilo;
  /**
   * Ventana de agrupacion estilo TikTok, en milisegundos. Ya no es
   * imprescindible (los grupos vienen pre-agrupados desde el backend); se
   * mantiene por compatibilidad y puede ignorarse.
   */
  combineTokensWithinMs: number;
  /** Subtitulos agrupados en frases (con palabras opcionales con timing). */
  grupos: Grupo[];
  /**
   * NUEVO (opcional para retrocompatibilidad): overlays de texto plano tipo
   * "hook". Un `props.json` sin este campo produce el render previo sin
   * overlays; el backend siempre lo emite como [] cuando no hay textos extra.
   */
  textosExtra?: TextoExtraProps[];
};
