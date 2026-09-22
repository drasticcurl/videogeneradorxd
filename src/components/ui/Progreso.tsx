"use client";

/**
 * Barra de progreso. El rediseño la pide en seis lugares con tres alturas
 * distintas (3px en el sidebar de tandas masivas, 4px en las cards de proyecto y en
 * las etapas del pipeline, 6px en los totales del tablero), asi que el alto es prop
 * y el resto es igual en todas.
 *
 * `tono` y no un color: `ok` para lo terminado e `info` para lo que esta corriendo,
 * que es el mismo significado que tienen en los badges. Una barra verde de algo que
 * todavia no termino miente.
 */

import { cn } from "@/lib/cn";
import type { Tone } from "@/lib/ui-tokens";

const RELLENO: Record<Tone, string> = {
  neutral: "bg-fg-dim",
  info: "bg-info",
  attention: "bg-accent",
  ok: "bg-ok",
  danger: "bg-danger",
};

export function Progreso({
  hechos,
  total,
  tono = "ok",
  alto = 4,
  className,
  etiqueta,
}: {
  hechos: number;
  total: number;
  tono?: Tone;
  alto?: 3 | 4 | 6;
  className?: string;
  /** Nombre accesible. Sin esto el `progressbar` se anuncia sin decir de que. */
  etiqueta?: string;
}) {
  // total 0 da NaN y el ancho queda en "NaN%", que el browser ignora: la barra se
  // ve al 100% y parece que termino algo que no existe.
  const pct = total > 0 ? Math.round((Math.min(hechos, total) / total) * 100) : 0;
  return (
    <div
      role="progressbar"
      aria-label={etiqueta}
      aria-valuenow={hechos}
      aria-valuemin={0}
      aria-valuemax={total}
      style={{ height: alto }}
      className={cn("w-full overflow-hidden rounded-sm bg-surface-hi", className)}
    >
      <div
        style={{ width: `${pct}%` }}
        className={cn("h-full rounded-sm transition-[width]", RELLENO[tono])}
      />
    </div>
  );
}

/**
 * Barra con su label y el contador "a/b" arriba. Es el patron de las cards de
 * proyecto en la home y de las etapas del pipeline, donde el numero importa tanto
 * como la barra.
 */
export function ProgresoConLabel({
  label,
  hechos,
  total,
  tono = "ok",
  alto = 4,
  className,
}: {
  label: string;
  hechos: number;
  total: number;
  tono?: Tone;
  alto?: 3 | 4 | 6;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-baseline justify-between gap-2 text-label text-fg-dim">
        <span className="truncate">{label}</span>
        <span className="code tnum flex-none text-fg">
          {hechos}/{total}
        </span>
      </div>
      <Progreso
        hechos={hechos}
        total={total}
        tono={tono}
        alto={alto}
        etiqueta={label}
      />
    </div>
  );
}
