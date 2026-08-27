/**
 * /batch/review?ids=a,b,c -> revision de imagenes de a una (tipo tinder).
 *
 * Wrapper server-side por el Suspense que necesita `useSearchParams`.
 */
import { Suspense } from "react";
import { ReviewDeck } from "./ReviewDeck";

export const dynamic = "force-dynamic";

export default function BatchReviewPage() {
  return (
    <Suspense
      fallback={<p className="text-sm text-slate-400">Cargando la cola…</p>}
    >
      <ReviewDeck />
    </Suspense>
  );
}
