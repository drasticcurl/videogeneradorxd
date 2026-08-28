"use client";

/**
 * Pestañas sobre Radix. CONTRATO CONGELADO (§5 del plan).
 *
 * Soporta controlado (`value` + `onValueChange`) y no controlado (`defaultValue`).
 * El modo lo elige la pantalla: varias de esta app ya manejan la pestaña activa en
 * su propio estado, y hay que respetar como lo hacen para no romper la logica que ya
 * tienen.
 *
 * Radix trae navegacion con flechas y roles ARIA correctos sin escribir nada. La
 * implementacion anterior (`ProjectTabs`) eran botones sueltos: no se podia navegar
 * con teclado.
 */

import * as RadixTabs from "@radix-ui/react-tabs";

import { cn } from "@/lib/cn";

export const Tabs = RadixTabs.Root;

export function TabsList({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof RadixTabs.List>) {
  return (
    <RadixTabs.List
      className={cn(
        // Subrayado y no pastilla: una barra de pastillas sobre fondo oscuro pesa
        // mas que el contenido que estas mirando.
        "flex items-center gap-1 border-b border-divider",
        className,
      )}
      {...props}
    >
      {children}
    </RadixTabs.List>
  );
}

export function TabsTrigger({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof RadixTabs.Trigger>) {
  return (
    <RadixTabs.Trigger
      className={cn(
        "-mb-px border-b-2 border-transparent px-3 py-2 text-body font-medium " +
          "text-fg-dim transition-colors hover:text-fg " +
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " +
          "data-[state=active]:border-accent data-[state=active]:text-fg",
        className,
      )}
      {...props}
    >
      {children}
    </RadixTabs.Trigger>
  );
}

export function TabsContent({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof RadixTabs.Content>) {
  return (
    <RadixTabs.Content
      className={cn(
        "pt-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        className,
      )}
      {...props}
    >
      {children}
    </RadixTabs.Content>
  );
}
