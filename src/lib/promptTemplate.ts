/**
 * Plantilla del prompt de VIDEO (Veo), externalizada a Markdown.
 *
 * La fuente editable/descargable vive en `prompts/veo-video-prompt.md`. Este modulo
 * es ISOMORFICO (sirve en server y en cliente): NO toca el filesystem. El server lee
 * el .md via `promptTemplate.server.ts` y se lo pasa al armador; el cliente usa el
 * DEFAULT embebido (o el texto que baja del endpoint /api/prompt-template).
 *
 * Los bloques se delimitan con comentarios HTML `<!-- block:KEY -->` ... `<!-- /block -->`
 * para poder documentar libremente alrededor sin romper el parser.
 */

/** Contenido por defecto: DEBE coincidir con `prompts/veo-video-prompt.md`. Es el fallback. */
export const DEFAULT_VEO_PROMPT_TEMPLATE = `# Plantilla del prompt de video (Veo)

Este archivo es la fuente de verdad del prompt que la app le manda a Veo.

## Bloques

<!-- block:intro -->
Animate the attached image into a realistic {{duration}}-second vertical {{aspect}} video.
<!-- /block -->

<!-- block:talking_head -->
Self-recorded UGC style: the person records themselves talking directly to camera. The recording setup can be either a phone held at arm's length OR a phone/camera mounted on a tripod (or a steady surface) with the person speaking hands-free — choose whatever looks most natural for this shot, do NOT force a phone visibly held in hand. Natural casual head and hand movement, warm hopeful conversational tone, relaxed natural framing, accurate lip-sync to the spoken line. No on-screen text. {{aspect}}.
<!-- /block -->

<!-- block:broll_voiceover -->
B-roll insert: NO person talking to camera and NO visible talking face or lip-sync. Show only the scene and action described above, with smooth natural camera movement and realistic lighting. The line below plays as OFF-SCREEN VOICEOVER narration over the footage (nobody mouths it on screen). No on-screen text. {{aspect}}.
<!-- /block -->

<!-- block:silent -->
Smooth natural motion with subtle camera movement and realistic lighting. No spoken dialogue. No on-screen text. {{aspect}}.
<!-- /block -->

<!-- block:voice_accent -->
VOICE & ACCENT (very important): the person speaks in RIOPLATENSE ARGENTINE SPANISH (Buenos Aires / porteno accent), NOT Mexican, NOT Castilian, NOT neutral Latin American Spanish. Use the characteristic Argentine intonation, "voseo" (vos / tenes / mande / mira), the typical "sh" sound for "ll" and "y" (yo = "sho", ya = "sha", llave = "shave"), and a relaxed, melodic portena cadence. Natural adult voice, warm and conversational, casual everyday delivery.
<!-- /block -->

<!-- block:dialogue_line -->
[DIALOGO] (speak exactly this, in Rioplatense Argentine Spanish): "{{dialogue}}"
<!-- /block -->

<!-- block:voiceover_line -->
[VOZ EN OFF / VOICEOVER] (off-screen narration, speak exactly this in Rioplatense Argentine Spanish): "{{dialogue}}"
<!-- /block -->
`;

/** Ruta relativa (desde la raiz del repo) del archivo editable. Solo informativa para la UI. */
export const VEO_PROMPT_TEMPLATE_RELPATH = "prompts/veo-video-prompt.md";

export type VeoBlockKey =
  | "intro"
  | "talking_head"
  | "broll_voiceover"
  | "silent"
  | "voice_accent"
  | "dialogue_line"
  | "voiceover_line";

/**
 * Extrae los bloques `<!-- block:KEY -->...<!-- /block -->` de un texto Markdown.
 * Devuelve un mapa key -> contenido (trim). Ignora todo lo que este fuera de bloques.
 */
export function parsePromptTemplate(md: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<!--\s*block:([a-zA-Z0-9_]+)\s*-->([\s\S]*?)<!--\s*\/block\s*-->/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    const key = m[1].trim();
    out[key] = m[2].trim();
  }
  return out;
}

/** Bloques del default, parseados una sola vez. Sirven de fallback por-bloque. */
const DEFAULT_BLOCKS = parsePromptTemplate(DEFAULT_VEO_PROMPT_TEMPLATE);

/** Reemplaza los placeholders `{{key}}` por sus valores. */
export function fillPlaceholders(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_full, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : _full
  );
}

export interface VeoRenderOptions {
  /** Descripcion visual/cinematografica del clip (en ingles). */
  videoPrompt: string;
  /** Linea de dialogo en es-AR; "" si es b-roll mudo. */
  dialogue?: string;
  durationSec: number;
  aspectRatio?: string;
  /** "avatar" (talking-head) | "broll" (inserto). Default: avatar. */
  assetType?: "avatar" | "broll";
}

/**
 * Ensambla el prompt final a partir del texto de la plantilla (Markdown con bloques).
 * Logica de seleccion:
 *  - avatar + dialogo -> talking_head + voice_accent + dialogue_line
 *  - broll  + dialogo -> broll_voiceover + voice_accent + voiceover_line
 *  - sin dialogo      -> silent
 */
export function renderVeoPromptFromTemplate(
  templateText: string,
  opts: VeoRenderOptions
): string {
  const blocks = parsePromptTemplate(templateText);
  const block = (k: VeoBlockKey): string => blocks[k] ?? DEFAULT_BLOCKS[k] ?? "";

  const dur = Math.max(1, Math.round(opts.durationSec));
  const aspect = opts.aspectRatio ?? "9:16";
  const dialogue = (opts.dialogue ?? "").trim();
  const hasDialogue = dialogue.length > 0;
  const isBroll = opts.assetType === "broll";

  const vars: Record<string, string> = {
    duration: String(dur),
    aspect,
    dialogue,
  };
  const fill = (t: string) => fillPlaceholders(t, vars).trim();

  const parts: string[] = [];

  const intro = fill(block("intro"));
  if (intro) parts.push(intro);

  if (opts.videoPrompt && opts.videoPrompt.trim()) {
    parts.push(opts.videoPrompt.trim());
  }

  if (hasDialogue && !isBroll) {
    parts.push(fill(block("talking_head")));
    parts.push(fill(block("voice_accent")));
    parts.push(fill(block("dialogue_line")));
  } else if (hasDialogue && isBroll) {
    parts.push(fill(block("broll_voiceover")));
    parts.push(fill(block("voice_accent")));
    parts.push(fill(block("voiceover_line")));
  } else {
    parts.push(fill(block("silent")));
  }

  return parts.filter((p) => p && p.length > 0).join("\n\n");
}
