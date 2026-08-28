"use client";

/**
 * Badge de estado. CONTRATO CONGELADO (§5 del plan).
 *
 * RECIBE `tone`, NUNCA UN COLOR. Este archivo es el UNICO lugar donde un `tone` se
 * traduce a clases de Tailwind. Es lo que garantiza que el mismo estado se vea igual
 * en las 8 pantallas: antes del rediseño `awaiting_approval` salia ambar en una y
 * gris en otra, porque cada pantalla decidia su color.
 */

import { cn } from "@/lib/cn";
import type { Tone } from "@/lib/ui-tokens";

/**
 * `attention` usa el acento a proposito: en esta app el acento significa "esto
 * espera algo de vos", que es exactamente lo que quiere decir ese estado.
 */
const TONOS: Record<Tone, { texto: string; fondo: string; punto: string }> = {
  neutral: { texto: "text-fg-dim", fondo: "bg-surface-hi", punto: "bg-fg-dim" },
  info: { texto: "text-info", fondo: "bg-info/10", punto: "bg-info" },
  attention: { texto: "text-accent", fondo: "bg-accent/10", punto: "bg-accent" },
  ok: { texto: "text-ok", fondo: "bg-ok/10", punto: "bg-ok" },
  danger: { texto: "text-danger", fondo: "bg-danger/10", punto: "bg-danger" },
};

export interface BadgeProps {
  tone: Tone;
  children: React.ReactNode;
  /** Muestra el punto de color. Con `animado`, pulsa. */
  punto?: boolean;
  /**
   * Solo lo usa el estado "generando". El pulso va con `motion-safe:`, asi que
   * prefers-reduced-motion lo apaga sin que la pantalla tenga que preguntar.
   */
  animado?: boolean;
  className?: string;
}

export function Badge({ tone, children, punto, animado, className }: BadgeProps) {
  const t = TONOS[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-label font-medium",
        t.fondo,
        t.texto,
        className,
      )}
    >
      {punto && (
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            t.punto,
            animado && "motion-safe:animate-pulse",
          )}
        />
      )}
      {children}
    </span>
  );
}
