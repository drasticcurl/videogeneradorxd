"use client";

/**
 * Input y Textarea, con label arriba y error abajo.
 *
 * CONTRATO CONGELADO (§5 del plan). `label` es OBLIGATORIO: no existe el campo sin
 * etiqueta. La app tenia varios con el placeholder haciendo de label, y cuando el
 * usuario escribe se pierde el contexto de que era ese campo.
 */

import { forwardRef, useId } from "react";

import { cn } from "@/lib/cn";

const CAJA =
  "w-full rounded-sm border bg-bg px-2.5 py-2 text-body text-fg " +
  "placeholder:text-fg-dim/60 transition-colors " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " +
  "disabled:cursor-not-allowed disabled:opacity-50";

interface Comun {
  label: string;
  hint?: string;
  error?: string;
  /** Oculta el label visualmente pero lo deja para el lector de pantalla. */
  labelOculto?: boolean;
  className?: string;
}

/** El label, el hint y el error. Compartido por Input y Textarea. */
function Envoltorio({
  id,
  label,
  hint,
  error,
  labelOculto,
  children,
}: Comun & { id: string; children: React.ReactNode }) {
  return (
    <div className="w-full">
      <label
        htmlFor={id}
        className={cn(
          "mb-1 block text-label font-medium text-fg-dim",
          labelOculto && "sr-only",
        )}
      >
        {label}
      </label>
      {children}
      {/*
        aria-live: el error suele aparecer DESPUES de un submit, asi que hay que
        anunciarlo. El contenedor existe siempre para que el lector de pantalla lo
        tenga registrado antes de que haya texto.
      */}
      <div aria-live="polite">
        {error ? (
          <p id={`${id}-error`} role="alert" className="mt-1 text-label text-danger">
            {error}
          </p>
        ) : hint ? (
          <p id={`${id}-hint`} className="mt-1 text-label text-fg-dim">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "className">,
    Comun {}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, labelOculto, className, id: idProp, ...props },
  ref,
) {
  const autoId = useId();
  const id = idProp ?? autoId;
  return (
    <Envoltorio {...{ id, label, hint, error, labelOculto }}>
      <input
        ref={ref}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={cn(CAJA, error ? "border-danger" : "border-border", className)}
        {...props}
      />
    </Envoltorio>
  );
});

export interface TextareaProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "className">,
    Comun {
  /** Para JSON y prompts: usa la fuente mono. */
  mono?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea(
    { label, hint, error, labelOculto, className, mono, id: idProp, ...props },
    ref,
  ) {
    const autoId = useId();
    const id = idProp ?? autoId;
    return (
      <Envoltorio {...{ id, label, hint, error, labelOculto }}>
        <textarea
          ref={ref}
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
          className={cn(
            CAJA,
            "resize-y",
            mono && "font-mono text-label",
            error ? "border-danger" : "border-border",
            className,
          )}
          {...props}
        />
      </Envoltorio>
    );
  },
);
