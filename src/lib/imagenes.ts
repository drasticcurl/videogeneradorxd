/**
 * Helpers de la pantalla de solo imagenes.
 *
 * Viven en lib/ y NO en el route.ts que los usa porque un archivo de ruta de Next
 * solo puede exportar los handlers HTTP (GET/POST/...) y un puñado de exports de
 * config conocidos. Exportar cualquier otra cosa rompe el build con
 * "does not match the required types of a Next.js Route" — y el `tsc --noEmit` NO
 * lo detecta, solo lo ve `next build`.
 *
 * ─── UN PROMPT POR PROYECTO ──────────────────────────────────────────────────
 *
 * Antes esta pantalla partia el texto pegado en un prompt POR LINEA y armaba un
 * proyecto con N imagenes. Se saco: un prompt de imagen de verdad tiene varias
 * lineas (encuadre, luz, estilo, negativos), asi que partir por linea convertia un
 * prompt en cinco prompts cortados al medio. Ahora el textarea es UN prompt, los
 * saltos de linea son parte del prompt, y la cantidad se maneja con variantes.
 */
import { slugify } from "./storage";

/**
 * Id de la imagen del proyecto, que es lo que termina siendo el NOMBRE DEL ARCHIVO:
 * `storage.imageRelPath()` hace `images/<slug(id)>.png`.
 *
 * "Crema Manos" -> crema_manos -> images/crema_manos.png
 *
 * Sin sufijo numerico: hay UNA imagen por proyecto. Las variantes no son imagenes
 * distintas, son candidatas del mismo job y el storage las guarda aparte.
 */
export function imageIdPara(nombre: string): string {
  return slugify(nombre) || "imagen";
}
