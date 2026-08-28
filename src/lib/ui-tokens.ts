/**
 * Como se ve cada estado de un job. FUENTE DE VERDAD UNICA.
 *
 * ─── POR QUE EXISTE ESTE ARCHIVO ─────────────────────────────────────────────
 *
 * Antes del rediseño este mapeo estaba duplicado en cuatro lugares
 * (`StatusBadge`, el `statusPill` del pipeline, y dos pantallas mas con su propio
 * `switch`), y habian divergido: `awaiting_approval` salia ambar en una pantalla y
 * gris en otra, y en varias se imprimia el string interno crudo
 * ("awaiting_approval") en la cara del usuario.
 *
 * Ninguna pantalla escribe su propio switch de estados. Si una necesita un label
 * distinto segun el contexto, se le agrega un parametro a `estadoDeJob`, no un
 * switch local.
 *
 * ─── DEVUELVE TOKENS, NO CLASES CSS ──────────────────────────────────────────
 *
 * A proposito: este modulo no sabe que existe Tailwind. La traduccion de `tone` a
 * clases la hace `Badge` y nadie mas. Asi cambiar el color de un estado es una
 * linea en `Badge`, y no abrir las 8 pantallas.
 */
import type { JobRecord } from "./types";

/**
 * Los cinco tonos del sistema. `attention` usa el color de acento porque en esta
 * app significan lo mismo: algo que espera una decision del usuario.
 */
export type Tone = "neutral" | "info" | "attention" | "ok" | "danger";

export interface EstadoVisual {
  tone: Tone;
  /** Para el usuario, en castellano. El `status` crudo no se muestra nunca. */
  label: string;
  /** Solo `generating`. Lo consume Badge, que respeta prefers-reduced-motion. */
  animado: boolean;
}

/**
 * Estado de un job -> como se ve.
 *
 * El default cubre cualquier estado que aparezca en el futuro sin que la UI se
 * rompa: cae en `neutral` y muestra el string crudo, que es fea pero honesta. Es
 * mejor que un badge invisible.
 */
export function estadoDeJob(status: JobRecord["status"] | string): EstadoVisual {
  switch (status) {
    case "pending":
      return { tone: "neutral", label: "En cola", animado: false };
    case "generating":
      return { tone: "info", label: "Generando", animado: true };
    case "awaiting_approval":
      return { tone: "attention", label: "Elegí variante", animado: false };
    case "done":
      return { tone: "ok", label: "Listo", animado: false };
    case "failed":
      return { tone: "danger", label: "Falló", animado: false };
    default:
      return { tone: "neutral", label: String(status), animado: false };
  }
}

/** Los niveles de `LogPanel`, con la misma escala de tonos. */
export function tonoDeLog(level: string): Tone {
  switch (level) {
    case "success":
      return "ok";
    case "warn":
      return "attention";
    case "error":
      return "danger";
    default:
      return "neutral";
  }
}

/**
 * Estado de un PROYECTO -> como se ve. Los valores salen de `ProjectStatus`.
 * `review` es el que mas importa: significa que el pipeline se detuvo esperando
 * algo del usuario, y hoy se lee como si hubiera terminado.
 */
export function estadoDeProyecto(status: string): EstadoVisual {
  switch (status) {
    case "draft":
      return { tone: "neutral", label: "Borrador", animado: false };
    case "running":
      return { tone: "info", label: "Generando", animado: true };
    case "review":
      return { tone: "attention", label: "Esperándote", animado: false };
    case "done":
      return { tone: "ok", label: "Listo", animado: false };
    case "failed":
      return { tone: "danger", label: "Falló", animado: false };
    case "paused":
      return { tone: "neutral", label: "Pausado", animado: false };
    default:
      return { tone: "neutral", label: String(status), animado: false };
  }
}
