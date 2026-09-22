"use client";

/**
 * La linea de tiempo de un proyecto, en sus dos formas. FUENTE DE VERDAD UNICA de
 * como se ve un clip como bloque.
 *
 * ─── POR QUE EXISTE ──────────────────────────────────────────────────────────
 *
 * El rediseño pide la tira de clips en cuatro lugares con tres alturas distintas: las
 * cards de proyecto de la home (28px), las filas del tablero (22px) y la linea de
 * tiempo grande del pipeline (44px, clickeable). Sin un componente unico son cuatro
 * mapeos de estado a color que divergen, que es exactamente el problema que
 * `ui-tokens` vino a resolver para los badges.
 *
 * ─── EL ANCHO ES PROPORCIONAL Y NO FIJO, Y ESO ES EL ARREGLO ─────────────────
 *
 * `ClipTimeline` daba a cada bloque `width: max(14, duracionSeg * 4)` px, o sea 32px
 * para un clip de 8s. Con el VSL real de 95 clips eso son 3040px de tira y aparecia
 * scroll horizontal (P-17 del plan viejo: "no escala con 95 clips"). Acá cada bloque
 * lleva `flex-grow: duracionSeg` con `flex-basis: 0`, asi que los 95 entran siempre en
 * el ancho que haya y la proporcion entre duraciones se mantiene. `min-w` evita que
 * un clip quede en 0px e invisible.
 */

import type { BatchTimelineItem } from "@/lib/batch";
import { cn } from "@/lib/cn";
import { estadoDeJob, type EstadoVisual, type Tone } from "@/lib/ui-tokens";

/**
 * Tono -> borde y relleno del bloque. El relleno va al 20% y no al 10% como en los
 * badges: un bloque de 3px de ancho con fondo al 10% no se distingue del carril.
 */
export const BLOQUE: Record<Tone, string> = {
  neutral: "border-divider bg-surface-hi",
  info: "border-info bg-info/20",
  attention: "border-accent bg-accent/20",
  ok: "border-ok bg-ok/20",
  danger: "border-danger bg-danger/20",
};

/**
 * Estado visual de un item de la timeline, incluido el caso que `ui-tokens` no
 * conoce: `placeholder` es un clip FILMAR_REAL, que no lo genera la IA y no es un
 * estado de job. Se le da `attention` (requiere al usuario) y el borde punteado, que
 * es lo que lo distingue de un clip que la IA todavia no empezo.
 */
export function estadoDeClip(item: BatchTimelineItem): EstadoVisual & {
  punteado: boolean;
} {
  if (item.status === "placeholder") {
    return { tone: "attention", label: "A filmar", animado: false, punteado: true };
  }
  return { ...estadoDeJob(item.status), punteado: false };
}

function tituloDe(item: BatchTimelineItem, estado: EstadoVisual): string {
  return (
    `${item.label} · ${item.duracionSeg}s · ${estado.label}` +
    (item.dialogo ? `\n"${item.dialogo}"` : "") +
    (item.error ? `\n${item.error}` : "")
  );
}

/**
 * Tira compacta, no interactiva. Va en las cards de la home y en las filas del
 * tablero: ahi la tira es un resumen de una ojeada, y el click lo maneja la fila
 * entera (abre el proyecto). Por eso los bloques son `<span>`: un boton adentro de
 * otro boton es HTML invalido y el click de adentro se come el de afuera.
 */
export function MiniTimeline({
  items,
  alto = 28,
  className,
}: {
  items: BatchTimelineItem[];
  alto?: number;
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <div
      style={{ height: alto }}
      className={cn("flex min-w-0 gap-0.5", className)}
      aria-hidden
    >
      {items.map((it) => {
        const estado = estadoDeClip(it);
        return (
          <span
            key={it.clipId}
            title={tituloDe(it, estado)}
            style={{ flex: `${it.duracionSeg} 0 0` }}
            className={cn(
              "min-w-[3px] rounded-sm border",
              BLOQUE[estado.tone],
              estado.punteado && "border-dashed",
              estado.animado && "motion-safe:animate-pulse",
            )}
          />
        );
      })}
    </div>
  );
}

/**
 * La linea de tiempo grande del pipeline: bloques altos, con el numero de orden
 * adentro y clickeables para seleccionar el clip.
 *
 * El seleccionado lleva un anillo BLANCO por fuera (`ring-2 ring-fg`) y no un borde
 * de acento: el borde ya lo usa el estado, y pisarlo hacia que el clip seleccionado
 * perdiera el color de su estado justo cuando lo estas mirando.
 */
export function TimelineClips({
  items,
  seleccionado,
  onSeleccionar,
  alto = 44,
  className,
}: {
  items: BatchTimelineItem[];
  seleccionado?: string | null;
  onSeleccionar: (clipId: string) => void;
  alto?: number;
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <div style={{ height: alto }} className={cn("flex min-w-0 gap-0.5", className)}>
      {items.map((it) => {
        const estado = estadoDeClip(it);
        const activo = it.clipId === seleccionado;
        return (
          <button
            key={it.clipId}
            type="button"
            title={tituloDe(it, estado)}
            aria-label={`Clip ${it.orden}: ${estado.label}`}
            aria-pressed={activo}
            onClick={() => onSeleccionar(it.clipId)}
            style={{ flex: `${it.duracionSeg} 0 0` }}
            className={cn(
              "code tnum min-w-[14px] overflow-hidden rounded-sm border p-0 text-label font-medium text-fg",
              "transition-opacity hover:opacity-80",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
              BLOQUE[estado.tone],
              estado.punteado && "border-dashed",
              estado.animado && "motion-safe:animate-pulse",
              activo && "ring-2 ring-fg",
            )}
          >
            {it.orden}
          </button>
        );
      })}
    </div>
  );
}

/** "2m 16s". Compartido por las pantallas que muestran la duracion total. */
export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
