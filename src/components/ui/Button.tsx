"use client";

/**
 * Boton. Reemplaza los 91 <button> escritos a mano que tenia la app.
 *
 * CONTRATO CONGELADO (§5 del plan): 11 tasks se escriben contra esta firma en
 * paralelo. No cambiarla.
 */

import { Slot } from "@radix-ui/react-slot";
import { type VariantProps, cva } from "class-variance-authority";
import { forwardRef } from "react";

import { cn } from "@/lib/cn";

const estilos = cva(
  // Base: el foco visible no es opcional (dos usuarios que trabajan con teclado), y
  // el `active:translate-y-px` es el unico movimiento del boton, para que se sienta
  // que respondio.
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md " +
    "font-medium transition-colors " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg " +
    "disabled:pointer-events-none disabled:opacity-50 " +
    "motion-safe:active:translate-y-px",
  {
    variants: {
      variant: {
        // Primario neutro y no de color: en esta app el color esta reservado para
        // los ESTADOS y para el contenido (imagenes y videos). Un primario blanco
        // sobre fondo casi negro es lo mas legible que hay (19:1) y no compite.
        primary: "bg-fg text-bg hover:bg-fg-dim",
        secondary: "border border-border bg-transparent text-fg hover:bg-surface-hi",
        ghost: "bg-transparent text-fg-dim hover:bg-surface-hi hover:text-fg",
        // Para lo que cuesta plata o borra cosas.
        danger: "border border-danger/40 bg-transparent text-danger hover:bg-danger/10",
      },
      size: {
        sm: "h-7 px-2.5 text-label",
        md: "h-9 px-3.5 text-body",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof estilos> {
  /** Deshabilita y muestra el spinner. NO cambia el texto: ver abajo. */
  loading?: boolean;
  icon?: React.ReactNode;
  /** Renderiza como el hijo (para envolver un <Link> sin anidar interactivos). */
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, loading, icon, asChild, children, disabled, ...props },
  ref,
) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      ref={ref}
      className={cn(estilos({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {/*
        El texto NO cambia cuando `loading` esta activo, y el spinner reemplaza al
        icono en lugar de sumarse. Las dos cosas por el mismo motivo: un boton que
        pasa de "Generar" a "Generando..." cambia de ancho y empuja el layout, y en
        una grilla de tarjetas eso hace saltar toda la fila.
      */}
      {loading ? (
        <span
          aria-hidden
          className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : (
        icon
      )}
      {children}
    </Comp>
  );
});
