/**
 * /batch/review?ids=a,b,c[&modo=img|vid] -> pantalla "Revisar", en modo Imágenes.
 *
 * Monta el mismo `ReviewBoard` que /batch/videos: el rediseño unifica las dos
 * pantallas en una sola con un segmented Imágenes/Clips (`revMode`, ver el comentario
 * grande en `ReviewBoard.tsx` sobre por qué es un componente compartido y no dos
 * pantallas que se redirigen entre si).
 *
 * Esta ruta sigue existiendo con su URL de siempre y arranca en modo "img" — el
 * link que hoy arma `/batch` con `?focus=` sigue funcionando igual. Si la URL ya
 * trae `?modo=`, `ReviewBoard` respeta ese valor por sobre el default de la ruta.
 *
 * ─── SIN ICONOS DE PHOSPHOR EN ESTE ARCHIVO ─────────────────────────────────
 *
 * Es un Server Component y `@phosphor-icons/react` 2.1.10 no trae la directiva
 * "use client": su `IconBase` consume un `createContext`, asi que importarlo desde el
 * server rompe el build DESPUES de imprimir "Compiled successfully". Los iconos del
 * deck viven en `ReviewBoard.tsx`, que si es cliente.
 */
import { Suspense } from "react";

import { Skeleton } from "@/components/ui";

import { ReviewBoard } from "../ReviewBoard";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Revisar imágenes · AUGC Pipeline",
};

export default function BatchReviewPage() {
  return (
    <Suspense fallback={<DeckCargando />}>
      <ReviewBoard modoInicial="img" />
    </Suspense>
  );
}

/**
 * Esqueleto con la FORMA de la pantalla de trabajo (header + grid de dos columnas a
 * alto completo), no un "Cargando…" suelto. Es el limite de Suspense, asi que se ve
 * una sola vez, mientras el cliente lee `?ids=` de la URL.
 */
function DeckCargando() {
  return (
    <div className="flex h-full min-h-0 flex-col" aria-busy aria-label="Cargando la cola de revisión">
      <div className="flex flex-none items-center gap-3 px-4 py-3">
        <Skeleton className="h-8 w-8" />
        <Skeleton className="h-6 w-40" />
        <Skeleton className="ml-auto h-7 w-32" />
      </div>
      <div className="grid min-h-0 flex-1 gap-4 border-t border-divider p-4 lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]">
        <Skeleton className="h-full w-full rounded-lg" />
        <Skeleton className="h-full w-full rounded-lg" />
      </div>
    </div>
  );
}
