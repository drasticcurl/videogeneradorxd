"use client";

/**
 * Los links del nav, con el activo marcado.
 *
 * Es un componente cliente MINIMO a proposito: `usePathname` necesita cliente, pero
 * el layout NO puede serlo porque lee la cookie de sesion en el server con
 * `currentUser(cookies())`. Convertir el layout entero en cliente significaria mandar
 * la sesion al browser, que es justo lo que la cookie httpOnly evita.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/cn";

const LINKS = [
  { href: "/", label: "Nuevo proyecto" },
  { href: "/imagenes", label: "Imágenes" },
  { href: "/batch", label: "Tablero" },
] as const;

export default function NavLinks() {
  const pathname = usePathname();

  return (
    <>
      {LINKS.map((l) => {
        // La home matchea exacto; el resto por prefijo, asi `/batch/review` deja
        // marcado "Tablero".
        const activo = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={activo ? "page" : undefined}
            className={cn(
              "rounded-md px-2.5 py-1.5 text-body transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
              activo
                ? "bg-surface-hi font-medium text-fg"
                : "text-fg-dim hover:text-fg",
            )}
          >
            {l.label}
          </Link>
        );
      })}
    </>
  );
}
