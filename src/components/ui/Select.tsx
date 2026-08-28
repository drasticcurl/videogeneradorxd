"use client";

/**
 * Select sobre Radix, no el <select> nativo.
 *
 * CONTRATO CONGELADO (§5 del plan).
 *
 * POR QUE NO EL NATIVO: el desplegable del <select> nativo no se puede estilar, lo
 * dibuja el sistema operativo. Los selectores de modelo de esta app tienen etiquetas
 * largas con emoji ("⚡ Nano Banana 2", "🪙 Veo 3.1 Lite") y un hint por opcion, y
 * sobre fondo oscuro el desplegable del sistema sale en claro y desentona.
 * Radix ademas trae navegacion con teclado y foco atrapado sin escribir nada.
 */

import { CaretDown, Check } from "@phosphor-icons/react";
import * as RadixSelect from "@radix-ui/react-select";
import { useId } from "react";

import { cn } from "@/lib/cn";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

export interface SelectProps<T extends string> {
  label: string;
  value: T;
  onValueChange: (v: T) => void;
  options: ReadonlyArray<SelectOption<T>>;
  labelOculto?: boolean;
  disabled?: boolean;
  className?: string;
}

export function Select<T extends string>({
  label,
  value,
  onValueChange,
  options,
  labelOculto,
  disabled,
  className,
}: SelectProps<T>) {
  const id = useId();
  return (
    <div className={cn("w-full", className)}>
      <label
        htmlFor={id}
        className={cn(
          "mb-1 block text-label font-medium text-fg-dim",
          labelOculto && "sr-only",
        )}
      >
        {label}
      </label>
      <RadixSelect.Root value={value} onValueChange={onValueChange} disabled={disabled}>
        <RadixSelect.Trigger
          id={id}
          className={
            "flex h-9 w-full items-center justify-between gap-2 rounded-sm border " +
            "border-border bg-bg px-2.5 text-body text-fg transition-colors " +
            "hover:bg-surface-hi focus-visible:outline-none focus-visible:ring-2 " +
            "focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
          }
        >
          <RadixSelect.Value />
          <RadixSelect.Icon>
            <CaretDown className="size-3.5 shrink-0 text-fg-dim" />
          </RadixSelect.Icon>
        </RadixSelect.Trigger>

        <RadixSelect.Portal>
          <RadixSelect.Content
            // `popper` y no `item-aligned`: con item-aligned el desplegable tapa al
            // trigger, y en pantallas densas se pierde de vista que se estaba
            // eligiendo.
            position="popper"
            sideOffset={4}
            className={
              "z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden " +
              "rounded-md border border-divider bg-surface shadow-lg"
            }
          >
            <RadixSelect.Viewport className="p-1">
              {options.map((o) => (
                <RadixSelect.Item
                  key={o.value}
                  value={o.value}
                  className={
                    "flex cursor-pointer select-none items-start gap-2 rounded-sm px-2 py-1.5 " +
                    "text-body text-fg outline-none data-[highlighted]:bg-surface-hi " +
                    "data-[state=checked]:text-accent"
                  }
                >
                  <span className="mt-0.5 size-3.5 shrink-0">
                    <RadixSelect.ItemIndicator>
                      <Check className="size-3.5" />
                    </RadixSelect.ItemIndicator>
                  </span>
                  <span className="min-w-0">
                    <RadixSelect.ItemText>{o.label}</RadixSelect.ItemText>
                    {o.hint && (
                      <span className="block text-label text-fg-dim">{o.hint}</span>
                    )}
                  </span>
                </RadixSelect.Item>
              ))}
            </RadixSelect.Viewport>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>
    </div>
  );
}
