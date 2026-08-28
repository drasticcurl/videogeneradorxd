/**
 * Helpers de la pantalla de solo imagenes.
 *
 * Viven en lib/ y NO en el route.ts que los usa porque un archivo de ruta de Next
 * solo puede exportar los handlers HTTP (GET/POST/...) y un puñado de exports de
 * config conocidos. Exportar cualquier otra cosa rompe el build con
 * "does not match the required types of a Next.js Route" — y el `tsc --noEmit` NO
 * lo detecta, solo lo ve `next build`.
 */
import { slugify } from "./storage";

/**
 * Parte el texto pegado en prompts, uno por linea.
 *
 * Se ignoran las lineas vacias (asi se puede separar con renglones en blanco) y se
 * saca la numeracion manual del estilo "1." o "3)" del arranque, que es como la
 * gente pega listas y quedaria dentro del prompt que se le manda al modelo.
 */
export function parsePrompts(texto: string): string[] {
  return texto
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/^\s*\d+\s*[.)-]\s*/, "").trim())
    .filter((l) => l.length > 0);
}

/**
 * Ids de imagen derivados del nombre del proyecto, que es lo que termina siendo el
 * NOMBRE DEL ARCHIVO: `storage.imageRelPath()` hace `images/<slug(id)>.png`.
 * "Crema Manos" con 3 prompts -> crema_manos_01/02/03 -> images/crema_manos_01.png
 *
 * El indice va con padStart(2) para que el orden alfabetico del explorador de
 * archivos coincida con el orden en que se pegaron los prompts (asi _10 no cae
 * entre _1 y _2).
 */
export function imageIdsPara(nombre: string, cantidad: number): string[] {
  const base = slugify(nombre) || "imagen";
  return Array.from(
    { length: cantidad },
    (_, i) => `${base}_${String(i + 1).padStart(2, "0")}`,
  );
}
