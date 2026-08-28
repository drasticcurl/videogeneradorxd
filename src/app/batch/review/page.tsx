/**
 * /batch/review?ids=a,b,c -> revision de imagenes de a una ("tipo tinder").
 *
 * Wrapper server-side por el limite de Suspense que necesita `useSearchParams`
 * (lo usa `ReviewDeck` para leer `?ids=` y `?focus=`).
 *
 * ─── SIN ICONOS DE PHOSPHOR EN ESTE ARCHIVO ─────────────────────────────────
 *
 * Es un Server Component y `@phosphor-icons/react` 2.1.10 no trae la directiva
 * "use client": su `IconBase` consume un `createContext`, asi que importarlo desde el
 * server rompe el build DESPUES de imprimir "Compiled successfully". Los iconos del
 * deck viven en `ReviewDeck.tsx`, que si es cliente. Ver P-12 en §10 del plan.
 */
import { Suspense } from "react";

import { Skeleton } from "@/components/ui";

import { ReviewDeck } from "./ReviewDeck";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Revisar imágenes · AUGC Pipeline",
};

export default function BatchReviewPage() {
  return (
    <Suspense fallback={<DeckCargando />}>
      <ReviewDeck />
    </Suspense>
  );
}

/**
 * Esqueleto con la FORMA del deck: encabezado, la imagen grande en 9:16 y el panel
 * del guion al costado. No un "Cargando la cola…" suelto, que era lo que habia: con
 * la forma correcta, cuando entra la primera imagen no se mueve nada de lugar.
 *
 * Es el limite de Suspense, asi que se ve una sola vez, mientras el cliente lee el
 * `?ids=` de la URL.
 */
function DeckCargando() {
  return (
    <div className="space-y-4" aria-busy aria-label="Cargando la cola de revisión">
      <div className="space-y-2 border-b border-divider pb-3">
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-1.5 w-full" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-3">
          <Skeleton className="h-5 w-56" />
          <Skeleton className="aspect-[9/16] w-full max-w-[23rem] rounded-lg" />
          <div className="flex gap-2">
            <Skeleton className="h-9 w-44" />
            <Skeleton className="h-9 w-32" />
            <Skeleton className="h-9 w-24" />
          </div>
        </div>
        <div className="space-y-3 rounded-lg bg-surface p-3">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      </div>
    </div>
  );
}
