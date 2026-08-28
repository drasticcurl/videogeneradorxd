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
  /**
   * Aplica los estilos del boton al hijo en vez de renderizar un <button>. Se usa
   * para que un <Link> se vea como boton sin anidar dos elementos interactivos.
   *
   * OJO: con `asChild`, `icon` y `loading` se IGNORAN. `Slot` de Radix acepta un
   * unico hijo y revienta con cualquier cosa que sean dos, incluso `null` mas el
   * hijo real ("Slot failed to slot onto its children"). Verificado. Asi que el
   * contenido lo pone el hijo, incluido su propio icono si lo quiere.
   */
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, loading, icon, asChild, children, disabled, ...props },
  ref,
) {
  const clases = cn(estilos({ variant, size }), className);

  // Rama aparte y no un `Comp` polimorfico: con Slot hay que pasar UN solo hijo, y
  // `disabled` no existe en un <a>. Intentar unificar las dos ramas es lo que hacia
  // que `asChild` reventara siempre.
  if (asChild) {
    return (
      <Slot ref={ref} className={clases} {...props}>
        {children}
      </Slot>
    );
  }

  return (
    <button
      ref={ref}
      className={clases}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {/*
        El texto NO cambia cuando `loading` esta activo, y el spinner REEMPLAZA al
        icono en lugar de sumarse. Las dos cosas por el mismo motivo: un boton que
        pasa de "Generar" a "Generando..." cambia de ancho y empuja el layout, y en
        una grilla de tarjetas eso hace saltar la fila entera.
      */}
      {loading ? (
        <span
          aria-hidden
          className="size-3.5 shrink-0 rounded-full border-2 border-current border-t-transparent motion-safe:animate-spin"
        />
      ) : (
        icon
      )}
      {children}
    </button>
  );
});
