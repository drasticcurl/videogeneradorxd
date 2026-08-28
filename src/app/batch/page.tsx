/**
 * /batch?ids=a,b,c -> TABLERO del lote.
 *
 * Wrapper server-side: `useSearchParams` (en BatchBoard) necesita un limite de
 * Suspense para que el build no se queje. El parametro sigue llamandose `ids`, que es
 * el mismo que leen /batch/review y /batch/videos.
 *
 * ─── SIN ICONOS DE PHOSPHOR EN ESTE ARCHIVO ─────────────────────────────────
 *
 * Es un Server Component y `@phosphor-icons/react` 2.1.10 no trae la directiva
 * "use client": su `IconBase` consume un `createContext`, asi que importarlo desde el
 * server rompe el build DESPUES de imprimir "Compiled successfully". Los iconos del
 * tablero viven en `BatchBoard.tsx`, que si es cliente. Ver P-12 en §10 del plan.
 */
import { Suspense } from "react";

import { Skeleton } from "@/components/ui";

import { BatchBoard } from "./BatchBoard";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Tablero de lote · AUGC Pipeline",
};

export default function BatchPage() {
  return (
    <Suspense fallback={<TableroCargando />}>
      <BatchBoard />
    </Suspense>
  );
}

/**
 * Esqueleto con la FORMA del tablero, no un "Cargando tablero…" suelto: cuando entra
 * el contenido real no se mueve nada de lugar. Es el limite de Suspense, asi que se
 * ve una sola vez, mientras el cliente lee el `?ids=` de la URL.
 */
function TableroCargando() {
  return (
    <div className="space-y-5" aria-busy aria-label="Cargando el tablero">
      <div className="space-y-2">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>
      <Skeleton className="h-9 w-full sm:max-w-sm" />
      <div className="space-y-3 rounded-lg bg-surface p-4">
        <Skeleton className="h-5 w-48" />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-1.5 w-full" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-1.5 w-full" />
          </div>
        </div>
      </div>
    </div>
  );
}
