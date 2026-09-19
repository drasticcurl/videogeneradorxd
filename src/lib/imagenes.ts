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
import type { ProjectPlan } from "./schema";

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

/**
 * Id de un turno del chat iterativo: `<imageIdBase>_v<n>`.
 *
 * `n` arranca en 2 porque v1 es la imagen original (la que crea `/api/imagenes`, con
 * `imageIdPara`). Sufijo numerico y no un uuid: asi el nombre de archivo en
 * `images/<slug>.png` sigue siendo legible ("crema_manos_v2.png") y el orden del
 * historial se puede leer directo del id sin ir al plan.
 */
export function chatTurnImageId(imageIdBase: string, turno: number): string {
  return `${imageIdBase}_v${turno}`;
}

/** Un eslabon del historial de un chat iterativo de imagenes, para la UI. */
export interface ChatTurn {
  imageId: string;
  prompt: string;
  /** null en el turno 0 si la raiz es una reference subida y no una Image del plan. */
  refImageId: string | null;
}

/**
 * Reconstruye la cadena de un chat iterativo siguiendo `ref_image_id` HACIA ATRAS
 * desde `imageId` hasta la raiz (una Image en modo text2image, o una image2image cuya
 * referencia es una `reference` subida — no otra Image del plan).
 *
 * Por que hace falta esto y no alcanza con recorrer `plan.assets` en la UI: el cliente
 * ve el plan a traves del manifest (que ya aplana images[] con su ref_image_id), pero
 * ARMAR el orden es seguir un puntero por proyecto entero cada vez, y hacerlo en cada
 * render del tablero (una vez por tanda visible) es exactamente el tipo de logica que
 * se rompe silenciosamente si el plan tiene un ciclo por un bug de otro lado. Vive en
 * el server, en un solo lugar, con un tope de iteraciones que corta cualquier ciclo.
 *
 * Devuelve la cadena ordenada de MAS VIEJA a MAS NUEVA (v1, v2, v3...). Si `imageId`
 * no existe en el plan, devuelve [].
 */
export function buildChatHistory(plan: ProjectPlan, imageId: string): ChatTurn[] {
  const byId = new Map<string, { ref_image_id?: string; prompt: string }>();
  for (const asset of plan.assets) {
    for (const img of asset.images) byId.set(img.id, img);
  }

  const chain: ChatTurn[] = [];
  const visto = new Set<string>();
  let cursor: string | undefined = imageId;

  // Tope defensivo: un plan corrupto con un ciclo (A -> B -> A) no puede colgar esto.
  // 200 alcanza y sobra: es mucho mas que cualquier chat iterativo real.
  for (let i = 0; i < 200 && cursor; i++) {
    const img = byId.get(cursor);
    if (!img || visto.has(cursor)) break;
    visto.add(cursor);
    chain.push({
      imageId: cursor,
      prompt: img.prompt,
      // ref_image_id puede apuntar a otra Image (sigue la cadena) o a una Reference
      // subida (raiz del chat, no sigue). Solo seguimos si es OTRA Image del plan.
      refImageId: img.ref_image_id ?? null,
    });
    cursor = img.ref_image_id && byId.has(img.ref_image_id) ? img.ref_image_id : undefined;
  }

  return chain.reverse();
}
