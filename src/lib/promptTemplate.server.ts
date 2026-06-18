/**
 * Loader SERVER-ONLY de la plantilla del prompt de video.
 *
 * Lee `prompts/veo-video-prompt.md` desde el filesystem en runtime (con cache por
 * mtime) para que, si el usuario edita ese .md, los prompts cambien sin recompilar.
 * Si el archivo no existe o no se puede leer, cae al DEFAULT embebido.
 *
 * IMPORTANTE: NO importar este modulo desde componentes de cliente (usa node:fs).
 */
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_VEO_PROMPT_TEMPLATE,
  VEO_PROMPT_TEMPLATE_RELPATH,
} from "./promptTemplate";

/** Ruta absoluta al .md editable (desde la raiz del proceso). */
export const VEO_PROMPT_TEMPLATE_PATH = path.join(
  process.cwd(),
  VEO_PROMPT_TEMPLATE_RELPATH
);

let cache: { mtimeMs: number; text: string } | null = null;

/**
 * Devuelve el texto de la plantilla. Usa cache mientras el mtime del archivo no cambie.
 * Si el archivo no existe / no se puede leer, devuelve el DEFAULT embebido.
 */
export function loadVeoPromptTemplateText(): string {
  try {
    const stat = fs.statSync(VEO_PROMPT_TEMPLATE_PATH);
    if (cache && cache.mtimeMs === stat.mtimeMs) return cache.text;
    const text = fs.readFileSync(VEO_PROMPT_TEMPLATE_PATH, "utf8");
    cache = { mtimeMs: stat.mtimeMs, text };
    return text;
  } catch {
    return DEFAULT_VEO_PROMPT_TEMPLATE;
  }
}

/** Indica si existe el archivo editable en disco (para informar en la UI). */
export function veoPromptTemplateExists(): boolean {
  try {
    return fs.statSync(VEO_PROMPT_TEMPLATE_PATH).isFile();
  } catch {
    return false;
  }
}
