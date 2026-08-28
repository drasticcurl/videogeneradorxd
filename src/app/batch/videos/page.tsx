/**
 * /batch/videos?ids=a,b,c -> revision de los clips generados, uno por uno.
 *
 * Wrapper server-side: `useSearchParams` (en `VideoDeck`) necesita un limite de
 * Suspense para que el build no se queje. El parametro sigue llamandose `ids`, que es
 * el mismo que leen /batch y /batch/review.
 *
 * ─── SIN ICONOS DE PHOSPHOR EN ESTE ARCHIVO ─────────────────────────────────
 *
 * Es un Server Component y `@phosphor-icons/react` 2.1.10 no trae la directiva
 * "use client": su `IconBase` consume un `createContext`, asi que importarlo desde el
 * server rompe el build DESPUES de imprimir "Compiled successfully". Los iconos de
 * esta pantalla viven en `VideoDeck.tsx`, que si es cliente. Ver P-12 en §10 del plan.
 *
 * `Skeleton` si se puede importar aca: no declara "use client" pero tampoco toca
 * Phosphor ni contexto, y `batch/page.tsx` ya lo hace igual (verificado con build).
 */
import { Suspense } from "react";

import { Skeleton } from "@/components/ui";

import { VideoDeck } from "./VideoDeck";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Revisar clips · AUGC Pipeline",
};

export default function BatchVideosPage() {
  return (
    <Suspense fallback={<DeckCargando />}>
      <VideoDeck />
    </Suspense>
  );
}

/**
 * Esqueleto con la FORMA del deck, no un "Cargando los clips…" suelto: cuando entra
 * el contenido real no se mueve nada de lugar. Es el limite de Suspense, asi que se
 * ve una sola vez, mientras el cliente lee el `?ids=` de la URL.
 *
 * La caja grande va en 9:16 porque es el formato de todo lo que genera la app, y es
 * exactamente el hueco donde despues aparece el video.
 */
function DeckCargando() {
  return (
    <div className="flex flex-col gap-4" aria-busy aria-label="Cargando los clips">
      <div className="flex flex-col gap-3 rounded-lg bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-80" />
          </div>
          <Skeleton className="h-9 w-40" />
        </div>
        <Skeleton className="h-5 w-full max-w-md" />
      </div>

      {/* La tira de navegacion: una fila de pastillas cuadradas. */}
      <div className="flex flex-wrap gap-1 rounded-lg bg-surface p-2.5">
        {Array.from({ length: 24 }, (_, i) => (
          <Skeleton key={i} className="size-7" />
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-5 w-72" />
          <Skeleton className="aspect-[9/16] w-full max-w-[min(20rem,35vh)] rounded-lg" />
          <Skeleton className="h-9 w-full max-w-md" />
        </div>
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    </div>
  );
}
