/**
 * Prompt de sistema y responseSchema para el parser (Gemini en Vertex AI).
 *
 * El objetivo: convertir un brief en lenguaje natural (formato libre, con marcas
 * [visual]/[audio] o prosa) en un PlanJSON estructurado y consistente.
 */

export const PARSER_SYSTEM_PROMPT = `Sos un director de arte y productor tecnico de anuncios UGC (user generated content) para funnels de quiz.
Tu trabajo es leer un brief en lenguaje natural (espanol, formato libre) y devolver UN UNICO objeto JSON valido
que describa el plan de produccion completo. NO escribas texto fuera del JSON.

ESTRUCTURA DE SALIDA (exacta):
{
  "global": {
    "idioma_dialogo": string,      // idioma de los dialogos, por defecto "es-AR" (espanol rioplatense, "vos")
    "formato": string,             // relacion de aspecto, por defecto "9:16"
    "reglas_realismo": string,     // reglas de realismo/estilo que apliquen a TODAS las imagenes/videos
    "negative_prompt": string      // negative prompt global (en ingles)
  },
  "assets": [
    {
      "id": string,                // slug corto, ej "avatar1", "broll_cocina"
      "tipo": "avatar" | "broll",
      "images": [
        {
          "id": string,            // slug unico en todo el proyecto, ej "avatar1_base"
          "modo": "text2image" | "image2image",
          "ref_image_id": string,  // SOLO si modo=image2image: id de OTRA imagen previa del proyecto
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
1. La PRIMERA imagen de cada avatar SIEMPRE es "text2image" (estado base, sin ref_image_id).
2. Los estados POSTERIORES del MISMO avatar (otra ropa, mas desinflada, en el espejo, etc.) SIEMPRE son
   "image2image" con "ref_image_id" apuntando a una imagen previa del MISMO avatar, y el prompt DEBE incluir
   explicitamente la instruccion "keep identity 100% consistent with the reference, same face, same person".
3. Todos los prompts visuales (image.prompt, image.negative_prompt, clip.video_prompt) van EN INGLES.
4. Todos los dialogos quedan en el idioma_dialogo (es-AR, registro "vos") SIN traducir.
5. Cada clip referencia una image_id que exista en el proyecto y un asset_id valido.
6. Asigna "orden" consecutivo segun la secuencia narrativa tipica del UGC: hook, reveal, escepticismo,
   mecanismo, warning, CTA (o el orden que indique el brief).
7. Marca "FILMAR_REAL" los clips que el brief pida grabar a mano/persona real; el resto "IA".
8. Si falta informacion para completar el esquema, RELLENA con defaults razonables y AGREGA una entrada en
   "warnings" describiendo el supuesto. NUNCA falles ni devuelvas campos vacios obligatorios.
9. Los ids deben ser slugs en minuscula sin espacios (a-z, 0-9, guion bajo).
10. negative_prompt global por defecto (si el brief no aclara): "blurry, deformed hands, extra fingers, text artifacts, watermark, low quality, plastic skin, oversaturated".

Devolve SOLO el JSON. Nada de markdown, ni \`\`\`, ni explicaciones.`;

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
      },
      required: ["idioma_dialogo", "formato", "reglas_realismo", "negative_prompt"],
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
