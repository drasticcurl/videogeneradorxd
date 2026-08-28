"use client";

/**
 * Navegacion entre las dos vistas de un proyecto (Pipeline / Resultado) + la salida
 * a "nuevo proyecto".
 *
 * Montado sobre el `Tabs` de T01 (Radix), con cada pestaña como `<Link>` via
 * `asChild`: la pestaña sigue siendo un link de verdad, asi que ctrl+click y "abrir
 * en pestaña nueva" siguen funcionando, y Radix agrega la navegacion con flechas.
 *
 * La pestaña activa la manda `usePathname()`, igual que antes. Es CONTROLADO a
 * proposito y sin `onValueChange`: quien cambia el estado es la navegacion, no un
 * click local. `activationMode="manual"` es la otra mitad de eso: con el default
 * ("automatic") mover la flecha ya activaria la pestaña, y en una barra de rutas eso
 * seria navegar sin querer. Asi la flecha mueve el foco y Enter navega.
 */

import { Plus } from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui";

export function ProjectTabs({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const tabs = [
    { href: `/project/${projectId}/pipeline`, label: "Pipeline" },
    { href: `/project/${projectId}/result`, label: "Resultado" },
  ];
  // Si el pathname no matchea ninguna (no deberia pasar), cae en la primera: Radix
  // necesita un `value` valido o no marca ninguna pestaña.
  const activa = tabs.find((t) => t.href === pathname)?.href ?? tabs[0].href;

  return (
    <div className="flex items-end gap-3">
      <Tabs value={activa} activationMode="manual" className="min-w-0 flex-1">
        <TabsList>
          {tabs.map((t) => (
            <TabsTrigger key={t.href} value={t.href} asChild>
              <Link
                href={t.href}
                aria-current={t.href === pathname ? "page" : undefined}
                /*
                  Radix arma el trigger sobre `Primitive.button`, asi que con asChild
                  le pasa `type="button"` al hijo. En un <a> ese atributo no existe:
                  es HTML invalido. Verificado renderizando el arbol real. El hijo
                  gana en el merge de props, asi que ponerlo en undefined lo saca.
                */
                type={undefined}
              >
                {t.label}
              </Link>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {/*
        "Nuevo" queda AFUERA del Tabs, no es una pestaña de este proyecto sino una
        salida a otra ruta. Adentro del tablist, Radix lo contaria como pestaña y la
        flecha derecha lo enfocaria como si fuera una, ademas de meter un elemento
        que no es `role="tab"` dentro de un `role="tablist"`.
      */}
      <Link
        href="/"
        className={
          "mb-1.5 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 " +
          "text-label font-medium text-fg-dim transition-colors " +
          "hover:bg-surface-hi hover:text-fg " +
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        }
      >
        <Plus className="size-3.5 shrink-0" aria-hidden />
        Nuevo
      </Link>
    </div>
  );
}
