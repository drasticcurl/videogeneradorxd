/**
 * Prompt de sistema y responseSchema para el parser (Gemini en Vertex AI).
 *
 * El objetivo: convertir un brief en lenguaje natural (formato libre, con marcas
 * [visual]/[audio] o prosa) en un PlanJSON estructurado y consistente.
 */

import type { Acento } from "./schema";

/** Idioma de dialogo por defecto segun acento. */
function defaultIdiomaDialogo(acento: Acento): string {
  return acento === "neutro" ? "es-419 (espanol neutro)" : "es-AR (espanol rioplatense, vos)";
}

/**
 * Instruccion de dialecto/registro para los DIALOGOS que arma el parser.
 * Cambia segun el acento elegido por el usuario (deslizable neutro / argentino).
 */
function parserDialectRule(acento: Acento): string {
  if (acento === "neutro") {
    return `4. Todos los dialogos quedan en el idioma_dialogo en ESPANOL NEUTRO latinoamericano (estandar, sin
   marca regional fuerte). NO uses voseo argentino, NO uses muletillas regionales (nada de che, dale,
   posta, boludo) ni modismos mexicanos. Usa un registro claro, natural y conversacional, entendible en
   toda Latinoamerica. Trato "tu" o impersonal segun convenga. NO traduzcas a otro idioma.`;
  }
  return `4. Todos los dialogos quedan en el idioma_dialogo (es-AR, registro "vos") SIN traducir. SIEMPRE espanol
   RIOPLATENSE ARGENTINO (acento de Buenos Aires / porteno), nunca neutro ni mexicano. Usa "voseo"
   (vos/tenes/mande/mira) y muletillas naturales argentinas (che, dale, posta, en serio, te juro).`;
}

/**
 * Arma el prompt de sistema del parser para el acento elegido. El bloque de dialecto
 * (regla 4) y el idioma_dialogo por defecto se adaptan a "arg" (rioplatense) o "neutro".
 */
export function buildParserSystemPrompt(acento: Acento = "arg"): string {
  return `Sos un director de arte y productor tecnico de anuncios UGC (user generated content) para funnels de quiz.
Tu trabajo es leer un brief en lenguaje natural (espanol, formato libre) y devolver UN UNICO objeto JSON valido
que describa el plan de produccion completo. NO escribas texto fuera del JSON.

ESTRUCTURA DE SALIDA (exacta):
{
  "global": {
    "idioma_dialogo": string,      // idioma de los dialogos, por defecto "${defaultIdiomaDialogo(acento)}"
    "formato": string,             // relacion de aspecto, por defecto "9:16"
    "reglas_realismo": string,     // reglas de realismo/estilo que apliquen a TODAS las imagenes/videos
    "negative_prompt": string,     // negative prompt global (en ingles)
    "acento": string               // "${acento}" (registro de voz/dialogo: "arg" rioplatense | "neutro")
  },
  "references": [                  // SOLO si el usuario subio fotos/avatares de referencia (VSL)
    {
      "id": string,                // slug del avatar de referencia (te lo paso yo, ej "natalia")
      "label": string              // nombre humano opcional, ej "Natalia Reyes"
    }
  ],
  "assets": [
    {
      "id": string,                // slug corto, ej "avatar1", "broll_cocina"
      "tipo": "avatar" | "broll",
      "images": [
        {
          "id": string,            // slug unico en todo el proyecto, ej "avatar1_base"
          "modo": "text2image" | "image2image",
          "ref_image_id": string,  // SOLO si modo=image2image: id de OTRA imagen previa, O id de una reference (foto subida)
          "ref_image_ids": [string], // OPCIONAL: varias referencias a la vez (ej. dos personas en un mismo plano)
          "prompt": string,        // EN INGLES, descripcion visual detallada y fotorrealista
          "negative_prompt": string // opcional, en ingles
        }
      ]
    }
  ],
  "clips": [
    {
      "id": string,                // slug, ej "hook", "reveal"
      "orden": number,             // 1,2,3... orden de aparicion en el anuncio final
      "asset_id": string,          // id de un asset existente
      "image_id": string,          // id de una imagen existente que se usa como frame inicial del video
      "video_prompt": string,      // EN INGLES: movimiento de camara, accion, expresion, ritmo
      "dialogo": string,           // en idioma_dialogo (es-AR, "vos"); "" si es b-roll mudo
      "duracion_seg": number,      // duracion del clip en segundos
      "etiqueta": "IA" | "FILMAR_REAL",
      "on_screen_text": string     // opcional: texto en pantalla sugerido
    }
  ],
  "warnings": [ string ]           // supuestos/defaults que tuviste que rellenar
}

REGLAS OBLIGATORIAS DE CONSISTENCIA:
0. AVATARES DE REFERENCIA (VSL): si te paso una lista de "AVATARES DE REFERENCIA DISPONIBLES" (fotos
   que el usuario YA subio), tenes que:
   - Incluir esos mismos ids en el array "references" (con su label si lo tiene).
   - Crear UN asset tipo "avatar" por cada persona de referencia, usando el MISMO id de la referencia.
   - La PRIMERA imagen de ese avatar tiene que ser "image2image" con "ref_image_id" = al id de la
     referencia (esa foto es la fuente de identidad). NO uses text2image para una persona que ya tiene
     foto de referencia: SIEMPRE partí de su foto.
   - Generá los demas planos (primer plano, plano medio, gestos, etc.) como "image2image" referenciando
     la imagen base de ESE avatar o directamente su referencia.
   - El prompt SIEMPRE debe incluir "keep identity 100% consistent with the reference, same face, same person".
   - Si un plano necesita a DOS personas de referencia juntas, usá "ref_image_ids" con los dos ids.
1. Si un avatar NO tiene foto de referencia, su PRIMERA imagen es "text2image" (estado base, sin ref).
2. Los estados POSTERIORES del MISMO avatar (otra ropa, mas desinflada, en el espejo, etc.) SIEMPRE son
   "image2image" con "ref_image_id" apuntando a una imagen previa del MISMO avatar (o a su referencia),
   y el prompt DEBE incluir explicitamente la instruccion
   "keep identity 100% consistent with the reference, same face, same person".
3. Todos los prompts visuales (image.prompt, image.negative_prompt, clip.video_prompt) van EN INGLES.
${parserDialectRule(acento)}
5. Cada clip referencia una image_id que exista en el proyecto y un asset_id valido.
6. Asigna "orden" consecutivo segun la secuencia narrativa del brief. Para un VSL largo de talking-head,
   respetá el ORDEN EXACTO de los bloques/lineas del guion: una linea de dialogo = un clip (6 u 8 seg).
7. Marca "FILMAR_REAL" los clips que el brief pida grabar a mano/persona real; el resto "IA".
   Los insertos marcados (B-ROLL) son clips IA de un asset "broll" (sin dialogo, el audio va por encima).
8. Si falta informacion para completar el esquema, RELLENA con defaults razonables y AGREGA una entrada en
   "warnings" describiendo el supuesto. NUNCA falles ni devuelvas campos vacios obligatorios.
9. Los ids deben ser slugs en minuscula sin espacios (a-z, 0-9, guion bajo).
10. negative_prompt global por defecto (si el brief no aclara): "blurry, deformed hands, extra fingers, text artifacts, watermark, low quality, plastic skin, oversaturated".
11. "formato" SIEMPRE es "9:16" (vertical).
12. "duracion_seg" SOLO puede ser 4, 6 u 8 (son las unicas duraciones validas de Veo). Si el brief pide otra (ej. 7), redondea a la mas cercana de esas tres.
13. Para clips de avatar que hablan a camara, el "video_prompt" (en ingles) debe describir el estilo del
    brief de forma EXPLICITA, asi se elige bien el armado del video:
    - VSL / testimonio formal: usa "talking-head, talks directly to camera", plano medio o primer plano,
      movimiento natural de cabeza/manos, lip-sync preciso, sin texto en pantalla, misma cara/ropa/set.
    - UGC / selfie casero: usa "UGC selfie, holds phone at arm's length", leve temblor de mano. SOLO cuando
      el brief realmente pida ese estilo casero (no lo pongas por defecto en todo).
    - b-roll: describi el movimiento de camara y la accion del objeto/escena; NO pongas una persona hablando.
      Si el b-roll lleva voz en off, dejalo igual como b-roll (el audio va por encima).

Devolve SOLO el JSON. Nada de markdown, ni \`\`\`, ni explicaciones.`;
}

/**
 * Prompt de sistema del parser para el acento por defecto (arg). Se mantiene como
 * constante para compatibilidad; el provider arma el prompt segun el acento elegido
 * con buildParserSystemPrompt(acento).
 */
export const PARSER_SYSTEM_PROMPT = buildParserSystemPrompt("arg");

/**
 * responseSchema para forzar JSON estructurado en Gemini (subset de OpenAPI que usa Vertex).
 * Los tipos van en MAYUSCULAS (STRING/OBJECT/ARRAY/NUMBER).
 */
export const PARSER_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    global: {
      type: "OBJECT",
      properties: {
        idioma_dialogo: { type: "STRING" },
        formato: { type: "STRING" },
        reglas_realismo: { type: "STRING" },
        negative_prompt: { type: "STRING" },
        acento: { type: "STRING", enum: ["arg", "neutro"] },
      },
      required: ["idioma_dialogo", "formato", "reglas_realismo", "negative_prompt"],
    },
    references: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          id: { type: "STRING" },
          label: { type: "STRING" },
        },
        required: ["id"],
      },
    },
    assets: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          id: { type: "STRING" },
          tipo: { type: "STRING", enum: ["avatar", "broll"] },
          images: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                id: { type: "STRING" },
                modo: { type: "STRING", enum: ["text2image", "image2image"] },
                ref_image_id: { type: "STRING" },
                ref_image_ids: { type: "ARRAY", items: { type: "STRING" } },
                prompt: { type: "STRING" },
                negative_prompt: { type: "STRING" },
              },
              required: ["id", "modo", "prompt"],
            },
          },
        },
        required: ["id", "tipo", "images"],
      },
    },
    clips: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          id: { type: "STRING" },
          orden: { type: "NUMBER" },
          asset_id: { type: "STRING" },
          image_id: { type: "STRING" },
          video_prompt: { type: "STRING" },
          dialogo: { type: "STRING" },
          duracion_seg: { type: "NUMBER" },
          etiqueta: { type: "STRING", enum: ["IA", "FILMAR_REAL"] },
          on_screen_text: { type: "STRING" },
        },
        required: [
          "id",
          "orden",
          "asset_id",
          "image_id",
          "video_prompt",
          "dialogo",
          "duracion_seg",
          "etiqueta",
        ],
      },
    },
    warnings: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["global", "assets", "clips", "warnings"],
} as const;

/**
 * Bloque de texto que se inyecta en el mensaje del usuario al parsear el brief,
 * para avisarle a la LLM que el usuario YA subio fotos/avatares de referencia (VSL).
 * Devuelve "" si no hay referencias.
 */
export function buildReferencesPromptBlock(
  references?: { id: string; label?: string }[]
): string {
  if (!references || references.length === 0) return "";
  const lines = references.map(
    (r) => `- id: "${r.id}"${r.label ? ` (persona: ${r.label})` : ""}`
  );
  return [
    "AVATARES DE REFERENCIA DISPONIBLES (fotos que el usuario YA subio; usalas como fuente de identidad):",
    ...lines,
    "",
    "Para CADA uno: incluilo en \"references\", creá un asset \"avatar\" con el MISMO id, y hacé que su",
    "imagen base sea image2image con ref_image_id = ese id. Generá todos los planos como image2image",
    "manteniendo la identidad (same face, same person). NO inventes una cara nueva con text2image.",
  ].join("\n");
}



/**
 * Plantilla COPIABLE para que el usuario genere el storyboard en CUALQUIER IA
 * (ChatGPT, Gemini, etc.) y obtenga EXACTAMENTE el JSON que la app espera.
 * Asi el formato nunca falla: el usuario pega el JSON resultante en "Pegar PlanJSON".
 * El acento (arg / neutro) cambia el idioma_dialogo sugerido y la regla de dialecto.
 */
export function buildStoryboardPromptTemplate(acento: Acento = "arg"): string {
  const idioma = acento === "neutro" ? "es-419" : "es-AR";
  const dialogoHint =
    acento === "neutro"
      ? "linea hablada en espanol NEUTRO latinoamericano (sin voseo ni modismos); '' si es b-roll mudo"
      : "linea hablada en es-AR (vos); '' si es b-roll mudo";
  const dialectoRule =
    acento === "neutro"
      ? "- Prompts visuales EN INGLES; dialogos en ESPANOL NEUTRO latinoamericano (sin voseo ni modismos regionales), sin traducir a otro idioma."
      : "- Prompts visuales EN INGLES; dialogos en es-AR (vos) sin traducir.";
  return `Actua como director de arte y productor tecnico de anuncios UGC para un funnel de quiz.
Te voy a pasar un brief de campaña y tenes que devolverme UN UNICO objeto JSON valido (sin markdown, sin texto extra)
con este formato EXACTO, que despues voy a pegar en mi app "AUGC Pipeline":

{
  "global": {
    "idioma_dialogo": "${idioma}",
    "formato": "9:16",
    "reglas_realismo": "string con reglas de estilo/realismo para todas las imagenes y videos",
    "negative_prompt": "string en ingles con lo que hay que evitar",
    "acento": "${acento}"
  },
  "references": [
    { "id": "natalia", "label": "Natalia Reyes" }   // SOLO si subiste fotos de avatares (VSL); si no, []
  ],
  "assets": [
    {
      "id": "slug_unico",                 // ej "avatar1", "broll_vaso" (para un avatar de referencia, usá su mismo id)
      "tipo": "avatar" | "broll",
      "images": [
        {
          "id": "slug_unico_global",      // ej "avatar1_base"
          "modo": "text2image" | "image2image",
          "ref_image_id": "id_de_otra_imagen_o_de_una_reference", // SOLO si modo=image2image
          "ref_image_ids": ["id1","id2"], // OPCIONAL: varias referencias (ej. dos personas en un plano)
          "prompt": "descripcion visual EN INGLES, fotorrealista",
          "negative_prompt": "EN INGLES (opcional)"
        }
      ]
    }
  ],
  "clips": [
    {
      "id": "slug",                       // ej "hook"
      "orden": 1,                         // 1,2,3... orden en el anuncio
      "asset_id": "id_de_un_asset",
      "image_id": "id_de_una_imagen",     // frame inicial del video
      "video_prompt": "movimiento de camara/accion/expresion EN INGLES (decí si es talking-head, UGC selfie o b-roll)",
      "dialogo": "${dialogoHint}",
      "duracion_seg": 8,                  // SOLO 4, 6 u 8
      "etiqueta": "IA" | "FILMAR_REAL",
      "on_screen_text": "texto en pantalla sugerido (opcional)"
    }
  ],
  "warnings": [ "supuestos o defaults que hayas tenido que asumir" ]
}

REGLAS QUE TENES QUE CUMPLIR SI O SI:
- "formato" siempre "9:16". "duracion_seg" solo 4, 6 u 8.
- AVATARES DE REFERENCIA (VSL): si yo te paso ids de fotos ya subidas, ponelos en "references", creá un
  asset "avatar" con el MISMO id por cada uno, y su imagen base tiene que ser "image2image" con
  "ref_image_id" = ese id (la foto es la fuente de identidad). NO uses text2image para una cara que ya
  tiene foto. Todos los planos posteriores: "image2image" manteniendo la identidad.
- Si un avatar NO tiene foto de referencia, su PRIMERA imagen es "text2image". Los demas estados del MISMO
  avatar son "image2image" con "ref_image_id" a una imagen previa, y el prompt tiene que incluir
  "keep identity 100% consistent with the reference, same face, same person".
- Para un VSL largo de talking-head: una linea del guion = un clip (6 u 8s), respetando el ORDEN exacto.
${dialectoRule}
- "image_id" y "asset_id" de cada clip tienen que existir en el JSON.
- ids en minuscula, sin espacios (a-z, 0-9, guion bajo).
- Si falta info, completa con defaults razonables y agregalo en "warnings". NUNCA dejes campos obligatorios vacios.
- Devolve SOLO el JSON.

ESTE ES EL BRIEF:
<<< PEGA ACA TU BRIEF >>>`;
}

/** Plantilla copiable por defecto (acento argentino), para compatibilidad. */
export const STORYBOARD_PROMPT_TEMPLATE = buildStoryboardPromptTemplate("arg");



/* ========================================================================
 * Construccion del prompt de VIDEO para Veo.
 *
 * Combina la cinematografia del clip con un BLOQUE DE ESTILO de toma elegido de
 * forma inteligente (UGC/selfie, talking-head o b-roll) y un bloque de VOZ & ACENTO
 * que respeta el acento elegido por el usuario (argentino rioplatense o neutro).
 * ===================================================================== */

/** Bloque de voz/acento argentino rioplatense. */
export const ARGENTINE_VOICE_BLOCK = `VOICE & ACCENT (very important): the person speaks in RIOPLATENSE ARGENTINE SPANISH (Buenos Aires / porteno accent), NOT Mexican, NOT Castilian, NOT neutral Latin American Spanish. Use the characteristic Argentine intonation, "voseo" (vos / tenes / mande / mira), the typical "sh" sound for "ll" and "y" (yo = "sho", ya = "sha", llave = "shave"), and a relaxed, melodic portena cadence. Natural adult voice, warm and conversational, casual everyday delivery.`;

/** Bloque de voz/acento NEUTRO latinoamericano (estandar, sin marca regional fuerte). */
export const NEUTRAL_VOICE_BLOCK = `VOICE & ACCENT (very important): the person speaks in NEUTRAL LATIN AMERICAN SPANISH (standard, accent-neutral), NOT specifically Argentine, NOT Mexican, NOT Castilian. Clear standard pronunciation, no strong regional slang or local idioms, neutral intonation understandable across all of Latin America. Natural adult voice, warm and conversational, casual everyday delivery.`;

/** Devuelve el bloque de voz/acento segun el acento elegido. */
export function voiceBlockFor(acento: Acento = "arg"): string {
  return acento === "neutro" ? NEUTRAL_VOICE_BLOCK : ARGENTINE_VOICE_BLOCK;
}

/** Como pedir el dialogo segun el acento. */
function dialogueLine(acento: Acento, dialogue: string): string {
  const lang =
    acento === "neutro"
      ? "neutral Latin American Spanish"
      : "Rioplatense Argentine Spanish";
  return `[DIALOGO] (speak exactly this, in ${lang}): "${dialogue}"`;
}

/**
 * Estilo de toma de un clip de video:
 *  - "ugc":          selfie casero, telefono a distancia de brazo (UGC).
 *  - "talking_head": persona hablando directo a camara, plano medio/primer plano (VSL/testimonio).
 *  - "broll":        plano de recurso (objeto/escena), SIN persona hablando a camara.
 */
export type ShotStyle = "ugc" | "talking_head" | "broll";

const UGC_HINTS =
  /\b(ugc|selfie|arm'?s? length|arms-length|front camera|handheld phone|holds? (the |their )?phone|filming (her|him|them)self|vlog|phone at arm)\b/i;
const HEAD_HINTS =
  /\b(talking[- ]?head|to camera|to-camera|direct(ly)? to camera|piece to camera|testimonial|interview|spokesperson|presenter|news anchor|addresses the camera|speaking to the camera)\b/i;
const BROLL_HINTS =
  /\b(b-?roll|insert shot|cutaway|product shot|macro( shot)?|close-?up of (the |a )?(product|bottle|jar|glass|food|plate|liquid|object|hands?)|establishing shot|scenery|landscape|empty (room|scene)|no person|stir(ring|red)?|pouring|texture)\b/i;

/**
 * Decide el estilo de toma de forma inteligente, para NO forzar siempre el estilo
 * UGC/selfie. Prioridad:
 *  1. assetTipo === "broll"  -> b-roll (nunca selfie, aunque tenga voz en off).
 *  2. pistas explicitas en el video_prompt (ugc / talking-head / b-roll).
 *  3. si hay dialogo y nada explicito -> talking-head (persona hablando, sin forzar selfie).
 *  4. si no hay dialogo -> b-roll (movimiento de escena, sin persona hablando).
 */
export function inferShotStyle(
  videoPrompt: string | undefined,
  hasDialogue: boolean,
  assetTipo?: "avatar" | "broll"
): ShotStyle {
  if (assetTipo === "broll") return "broll";
  const text = videoPrompt ?? "";
  if (UGC_HINTS.test(text)) return "ugc";
  if (HEAD_HINTS.test(text)) return "talking_head";
  if (BROLL_HINTS.test(text)) return "broll";
  return hasDialogue ? "talking_head" : "broll";
}

export interface VeoPromptInput {
  /** Descripcion visual/cinematografica del clip (en ingles). */
  videoPrompt: string;
  /** Linea de dialogo; "" si es b-roll mudo. */
  dialogue?: string;
  durationSec: number;
  aspectRatio?: string;
  /** texto en pantalla a evitar quemar en el video (lo agrega el usuario aparte). */
  noOnScreenText?: boolean;
  /** Acento/registro de la voz. Default "arg" (rioplatense). */
  acento?: Acento;
  /** Tipo del asset del clip (avatar/broll). Ayuda a decidir el estilo de toma. */
  assetTipo?: "avatar" | "broll";
  /** Estilo de toma EXPLICITO. Si no viene, se infiere del video_prompt/assetTipo. */
  shotStyle?: ShotStyle;
  /**
   * OVERRIDE del prompt final. Si viene con contenido, se devuelve TAL CUAL y se ignora
   * todo el armado automatico (estilo de toma, lip-sync, voz/acento, etc.). Permite que
   * el usuario controle exactamente lo que se le manda a Veo (ej. b-roll sin persona hablando).
   */
  override?: string;
}

/**
 * Arma el prompt final que se manda a Veo, combinando la cinematografia del clip
 * con el estilo de toma adecuado (UGC/selfie, talking-head o b-roll, elegido de forma
 * inteligente y NO forzando selfie siempre) y el bloque de voz/acento elegido.
 *
 * Si `input.override` tiene contenido, se devuelve EXACTAMENTE ese texto (sin armado
 * automatico): el usuario tiene control total sobre lo que se ejecuta.
 */
export function buildVeoVideoPrompt(input: VeoPromptInput): string {
  // Override manual: se usa tal cual, sin ningun agregado.
  const override = input.override?.trim();
  if (override) return override;

  const dur = Math.max(1, Math.round(input.durationSec));
  const aspect = input.aspectRatio ?? "9:16";
  const acento: Acento = input.acento ?? "arg";
  const hasDialogue = Boolean(input.dialogue && input.dialogue.trim().length > 0);
  const style: ShotStyle =
    input.shotStyle ?? inferShotStyle(input.videoPrompt, hasDialogue, input.assetTipo);

  const parts: string[] = [];
  parts.push(
    `Animate the attached image into a realistic ${dur}-second vertical ${aspect} video.`
  );
  if (input.videoPrompt && input.videoPrompt.trim()) {
    parts.push(input.videoPrompt.trim());
  }

  if (style === "broll") {
    // B-roll: nunca persona hablando a camara. Si hay "dialogo", es voz en off.
    if (hasDialogue) {
      parts.push(
        "B-roll style: focus on the scene and the action/object described, smooth natural camera " +
          "movement and realistic lighting. Do NOT show a person talking to camera, no lip-sync. " +
          `No on-screen text. ${aspect}.`
      );
      parts.push(voiceBlockFor(acento));
      parts.push(
        `[VOICE-OVER NARRATION] (heard over the footage, spoken in ${
          acento === "neutro" ? "neutral Latin American Spanish" : "Rioplatense Argentine Spanish"
        }): "${input.dialogue!.trim()}"`
      );
    } else {
      parts.push(
        "B-roll style: smooth natural motion with subtle camera movement and realistic lighting, " +
          `focus on the scene/object. No person talking, no spoken dialogue. No on-screen text. ${aspect}.`
      );
    }
    return parts.join("\n\n");
  }

  // Estilos con persona hablando a camara (ugc / talking_head).
  if (hasDialogue) {
    if (style === "ugc") {
      parts.push(
        "UGC selfie style: the person holds their phone at arm's length and talks directly to camera, " +
          "natural casual head and hand movement, warm conversational tone, subtle handheld shake, " +
          `accurate lip-sync to the spoken line. No on-screen text. ${aspect}.`
      );
    } else {
      // talking_head: directo a camara, sin forzar el selfie con telefono.
      parts.push(
        "Talking-head style: the person talks directly to camera in a natural, conversational way, " +
          "medium or close-up framing, subtle natural head and hand movement, steady framing, realistic " +
          `expression, accurate lip-sync to the spoken line. No on-screen text. ${aspect}.`
      );
    }
    parts.push(voiceBlockFor(acento));
    parts.push(dialogueLine(acento, input.dialogue!.trim()));
  } else {
    parts.push(
      "Smooth natural motion with subtle camera movement and realistic lighting. " +
        `No spoken dialogue. No on-screen text. ${aspect}.`
    );
  }

  return parts.join("\n\n");
}



/* ========================================================================
 * Construccion de la instruccion de IMAGEN (Nano Banana).
 * Se comparte entre el provider (lo que realmente se ejecuta) y el preview
 * (lo que se le muestra al usuario), para que sean IDENTICOS.
 * ===================================================================== */

export interface ImageInstructionInput {
  /** prompt visual de la imagen (en ingles). */
  prompt: string;
  /** cuantas imagenes de referencia se adjuntan (0 = text2image). */
  refCount: number;
  aspectRatio?: string;
  negativePrompt?: string;
}

/** Arma la instruccion de texto que se manda a Nano Banana (text2image o image2image). */
export function buildImageInstruction(input: ImageInstructionInput): string {
  const aspect = input.aspectRatio ?? "9:16";
  const isEdit = input.refCount > 0;
  const multi = input.refCount > 1;
  const identityLine = multi
    ? "IMPORTANT: keep EACH person's identity 100% consistent with their reference photo " +
      "(same faces, same people). Combine them naturally in one shot. " +
      "Only change what the instruction asks (pose, framing, wardrobe context). "
    : "IMPORTANT: keep identity 100% consistent with the reference image, " +
      "same face, same person. Only change what the instruction asks. ";
  return isEdit
    ? input.prompt +
        "\n\n" +
        identityLine +
        `Output a single vertical ${aspect} image.` +
        (input.negativePrompt ? `\nAvoid: ${input.negativePrompt}` : "")
    : input.prompt +
        `\n\nOutput a single photorealistic vertical ${aspect} image.` +
        (input.negativePrompt ? `\nAvoid: ${input.negativePrompt}` : "");
}
