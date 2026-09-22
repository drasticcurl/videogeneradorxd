"use client";

/**
 * Tarjeta con un switch adentro, clickeable entera.
 *
 * La usan los dos switches que cambian como se gasta la plata: "Prompt dual" en el
 * generador masivo (pasa de N variantes a 4 fijas por foto) y "Aprobar solo"
 * (autoApprove: saca el gate por lotes y deja que la cola siga sin preguntar). En los
 * dos casos la explicacion es mas importante que el control, y un checkbox de 16px
 * con un parrafo al lado deja la explicacion como letra chica.
 *
 * Es un `<button role="switch">` y no un `<input type="checkbox">`: el area
 * clickeable es la tarjeta completa, y anidar un input adentro de algo clickeable da
 * dos objetivos de click superpuestos con el label peleandose el foco.
 */

import { cn } from "@/lib/cn";

export function ToggleCard({
  activo,
  onChange,
  title,
  descripcion,
  className,
}: {
  activo: boolean;
  onChange: (v: boolean) => void;
  title: string;
  /** Cambia segun el estado: tiene que decir que pasa AHORA, no que hace el switch. */
  descripcion: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={activo}
      onClick={() => onChange(!activo)}
      className={cn(
        "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        activo
          ? "border-accent bg-accent/10"
          : "border-divider bg-surface hover:border-border",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "relative mt-0.5 h-[18px] w-8 flex-none rounded-full transition-colors",
          activo ? "bg-accent" : "bg-surface-hi",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-3.5 rounded-full bg-fg transition-[left]",
            activo ? "left-[16px]" : "left-0.5",
          )}
        />
      </span>
      <span className="min-w-0">
        <span className="block font-medium text-fg">{title}</span>
        <span className="mt-0.5 block text-label leading-4 text-fg-dim">
          {descripcion}
        </span>
      </span>
    </button>
  );
}

/**
 * La tecla que dispara una accion, al lado de su boton. Va en las barras de accion de
 * Revisar, que es la pantalla donde se aprueba de a 95 clips y donde el teclado deja
 * de ser un atajo y pasa a ser el modo de uso.
 *
 * `aria-hidden`: el lector de pantalla ya lee el label del boton, y "Aprobar y seguir
 * A" suena a que hay que decir una A.
 */
export function Kbd({
  children,
  sobreAccent,
}: {
  children: React.ReactNode;
  /** Adentro de un boton de fondo accent, donde `surface-hi` no contrasta. */
  sobreAccent?: boolean;
}) {
  return (
    <kbd
      aria-hidden
      className={cn(
        "code tnum rounded-sm px-1.5 py-px text-label font-medium",
        sobreAccent ? "bg-on-accent/15 text-on-accent" : "bg-surface-hi text-fg-dim",
      )}
    >
      {children}
    </kbd>
  );
}
