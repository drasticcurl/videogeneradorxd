/**
 * Placeholder de carga. CONTRATO CONGELADO (§5 del plan).
 *
 * Bloques con la FORMA del contenido final, no un spinner centrado. Varias pantallas
 * de esta app tardan segundos en el primer fetch (`/api/parse` puede tardar 20s), y
 * un esqueleto con la forma correcta hace que el salto al contenido real no mueva
 * nada de lugar.
 */

import { cn } from "@/lib/cn";

export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn(
        "rounded-sm bg-surface-hi motion-safe:animate-pulse",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Esqueleto de una grilla de medios en 9:16, que es el formato de todo lo que genera
 * la app. Lo usan la pantalla de imagenes, la de videos y la de resultado.
 */
export function SkeletonGrid({ items = 6 }: { items?: number }) {
  return (
    <div
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
      aria-busy
      aria-label="Cargando"
    >
      {Array.from({ length: items }, (_, i) => (
        <Skeleton key={i} className="aspect-[9/16] w-full rounded-lg" />
      ))}
    </div>
  );
}
