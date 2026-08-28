"use client";

/**
 * Dialogo sobre Radix. CONTRATO CONGELADO (§5 del plan).
 *
 * Radix da foco atrapado, cierre con Escape, click afuera y `aria-modal` sin
 * escribir nada. Escribir eso a mano y olvidarse del foco atrapado es como se hacen
 * los modales que dejan al usuario tabulando por detras del overlay.
 *
 * En esta app se usa sobre todo para CONFIRMAR ACCIONES QUE CUESTAN PLATA:
 * regenerar un video son varios dolares y "regenerar todos" en un VSL de 95 clips
 * son decenas. Por eso `Confirmar` de abajo pide el detalle del costo.
 */

import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "@phosphor-icons/react";

import { cn } from "@/lib/cn";

import { Button } from "./Button";

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

export function DialogContent({
  className,
  children,
  title,
  description,
  ...props
}: React.ComponentPropsWithoutRef<typeof RadixDialog.Content> & {
  title: string;
  description?: string;
}) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="fixed inset-0 z-50 bg-bg/80 motion-safe:animate-in motion-safe:fade-in" />
      <RadixDialog.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 " +
            "-translate-y-1/2 rounded-lg border border-divider bg-surface p-5 shadow-xl " +
            "focus-visible:outline-none",
          className,
        )}
        {...props}
      >
        <RadixDialog.Title className="text-title font-semibold text-fg">
          {title}
        </RadixDialog.Title>
        {description && (
          <RadixDialog.Description className="mt-1 text-body text-fg-dim">
            {description}
          </RadixDialog.Description>
        )}
        <div className="mt-4">{children}</div>
        <RadixDialog.Close
          aria-label="Cerrar"
          className="absolute right-3 top-3 rounded-sm p-1 text-fg-dim transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <X className="size-4" />
        </RadixDialog.Close>
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}

/**
 * Confirmacion lista para usar. `detalle` es donde va el costo: "Son 95 videos" o
 * "Esto vuelve a generar 3 clips". Que el numero este a la vista es la diferencia
 * entre una confirmacion util y un click de mas.
 */
export function Confirmar({
  abierto,
  onCambio,
  title,
  detalle,
  labelConfirmar = "Confirmar",
  peligroso,
  onConfirmar,
}: {
  abierto: boolean;
  onCambio: (v: boolean) => void;
  title: string;
  detalle: string;
  labelConfirmar?: string;
  peligroso?: boolean;
  onConfirmar: () => void;
}) {
  return (
    <Dialog open={abierto} onOpenChange={onCambio}>
      <DialogContent title={title} description={detalle}>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onCambio(false)}>
            Cancelar
          </Button>
          <Button
            variant={peligroso ? "danger" : "primary"}
            onClick={() => {
              onConfirmar();
              onCambio(false);
            }}
          >
            {labelConfirmar}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
