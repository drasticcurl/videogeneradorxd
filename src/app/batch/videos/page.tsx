/**
 * /batch/videos?ids=a,b,c[&modo=img|vid] -> pantalla "Revisar", en modo Clips.
 *
 * Monta el mismo `ReviewBoard` que /batch/review, arrancando en modo "vid". Ver el
 * comentario grande en `ReviewBoard.tsx`.
 *
 * ─── SIN ICONOS DE PHOSPHOR EN ESTE ARCHIVO ─────────────────────────────────
 *
 * Es un Server Component: los iconos de esta pantalla viven en `ReviewBoard.tsx`,
 * que si es cliente (ver P-12 del plan viejo — misma razon que /batch/review).
 */
import { Suspense } from "react";

import { Skeleton } from "@/components/ui";

import { ReviewBoard } from "../ReviewBoard";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Revisar clips · AUGC Pipeline",
};

export default function BatchVideosPage() {
  return (
    <Suspense fallback={<DeckCargando />}>
      <ReviewBoard modoInicial="vid" />
    </Suspense>
  );
}

/** Mismo esqueleto que /batch/review: las dos rutas montan la misma forma de pantalla. */
function DeckCargando() {
  return (
    <div className="flex h-full min-h-0 flex-col" aria-busy aria-label="Cargando los clips">
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
