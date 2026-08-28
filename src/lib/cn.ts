/**
 * Merge de clases de Tailwind.
 *
 * `clsx` resuelve los condicionales y `twMerge` resuelve los CONFLICTOS: si a un
 * componente le llegan `p-2` por default y `p-4` por prop, gana `p-4`. Sin twMerge
 * quedan las dos en el string y gana la que Tailwind haya puesto antes en el CSS,
 * que no es la que el llamador espera.
 *
 * `tailwind-merge` esta pinneado en 2.6.1 a proposito: la linea 3.x esta hecha para
 * Tailwind v4 y este proyecto usa 3.4.19.
 *
 * ─── POR QUE HAY UN extendTailwindMerge Y NO EL twMerge PELADO ───────────────
 *
 * tailwind-merge NO lee `tailwind.config.ts`: trae la escala de Tailwind por
 * defecto compilada adentro. La escala tipografica de este proyecto usa nombres
 * propios (`label`, `body`, `title`, `display`) en vez de los nativos (`xs`, `sm`,
 * `base`, `lg`), asi que sin esta extension `text-label` NO le figura como un tamaño:
 * cae en el grupo `text-color`, porque ese grupo valida con `isAny` y acepta
 * cualquier sufijo.
 *
 * Consecuencia: dos clases que el merge cree del mismo grupo, y se queda con la
 * ultima. Reproducido con el twMerge real:
 *
 *     twMerge("text-label text-fg-dim")       // => "text-fg-dim"      perdio el tamaño
 *     twMerge("bg-fg text-bg", "text-label")  // => "bg-fg text-label"  perdio el COLOR
 *     twMerge("text-xs text-red-500")         // => las dos: los nombres NATIVOS si andan
 *
 * En el CSS compilado no hay ningun conflicto: `.text-label` es `font-size` y
 * `.text-fg-dim` es `color`. El conflicto lo inventaba el merge.
 *
 * El caso peor era `Button variant="primary"`, que es `bg-fg text-bg`: perdia el
 * `text-bg`, heredaba `fg`, y quedaba texto casi blanco sobre fondo casi blanco.
 * Un boton primario INVISIBLE, sin ningun error, que compila y pasa el typecheck.
 * Lo encontraron los dos agentes de la ola 2 por separado, cada uno en su pantalla.
 *
 * Si mañana se agrega un tamaño a `fontSize` en tailwind.config.ts, HAY QUE
 * agregarlo a la lista de abajo. `tasks/_verificacion-cn.mjs` falla si se olvida.
 */
import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** Los nombres de `theme.extend.fontSize` de tailwind.config.ts. */
export const TAMANIOS_DE_TEXTO = ["label", "body", "title", "display"] as const;

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: [...TAMANIOS_DE_TEXTO] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
