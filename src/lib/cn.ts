/**
 * Merge de clases de Tailwind.
 *
 * `clsx` resuelve los condicionales y `twMerge` resuelve los CONFLICTOS: si a un
 * componente le llegan `p-2` por default y `p-4` por prop, gana `p-4`. Sin twMerge
 * quedan las dos en el string y gana la que Tailwind haya puesto antes en el CSS,
 * que no es la que el llamador espera.
 *
 * `tailwind-merge` esta pinneado en 2.6.1 a proposito: la linea 3.x esta hecha para
 * Tailwind v4 y este proyecto usa 3.4.19. Con la 3.x los grupos de utilidades no se
 * reconocen y el merge deja pasar clases que deberian pisarse. El sintoma es "le
 * puse una clase y no tomo", intermitente y molesto de rastrear.
 */
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
