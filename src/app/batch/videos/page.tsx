/**
 * /batch/videos?ids=a,b,c -> revision de los clips generados, uno por uno.
 */
import { Suspense } from "react";
import { VideoDeck } from "./VideoDeck";

export const dynamic = "force-dynamic";

export default function BatchVideosPage() {
  return (
    <Suspense
      fallback={<p className="text-sm text-slate-400">Cargando los clips…</p>}
    >
      <VideoDeck />
    </Suspense>
  );
}
