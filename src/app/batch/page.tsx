/**
 * /batch?ids=a,b,c -> TABLERO del lote.
 *
 * Wrapper server-side: `useSearchParams` (en BatchBoard) necesita un limite de
 * Suspense para que el build no se queje.
 */
import { Suspense } from "react";
import { BatchBoard } from "./BatchBoard";

export const dynamic = "force-dynamic";

export default function BatchPage() {
  return (
    <Suspense
      fallback={<p className="text-sm text-slate-400">Cargando tablero…</p>}
    >
      <BatchBoard />
    </Suspense>
  );
}
