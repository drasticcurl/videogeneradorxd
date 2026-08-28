"use client";
/**
 * Lo que va a costar la tanda, ANTES de generar. Es la ultima pantalla que el usuario
 * ve antes de gastar plata de verdad, asi que el numero grande es el monto.
 *
 * Todos los numeros van en `code tnum` (D4). No es decoracion: el panel se recalcula
 * mientras el usuario edita el plan, y en proporcional cada cifra cambia de ancho y
 * la fila entera salta.
 *
 * Muestra exactamente los mismos datos que antes, ni uno mas: el rediseño es visual.
 *
 * SOBRE EL NUMERO EN SI — ver P-02 del plan. `PRICE_VIDEO_PER_SEC_USD` quedo en 0.50,
 * que era el precio de Veo 3.1 normal, y el default ahora es Veo 3.1 Lite, mas
 * barato: el panel SOBREESTIMA. Corregirlo es cambiar `src/lib/config.ts`, que es
 * intocable y es otro dominio. Aca la aritmetica no se toca: se muestra el numero que
 * da la API tal cual y el titulo dice "estimado", que es lo honesto mientras P-02 no
 * se resuelva.
 */
import { Card, CardHeader, CardTitle } from "@/components/ui";
import type { CostEstimate } from "@/store/useProjectStore";

export function CostEstimatePanel({ estimate }: { estimate: CostEstimate }) {
  return (
    <Card>
      <CardHeader className="items-center">
        <CardTitle>Costo estimado antes de generar</CardTitle>
        {/*
          El monto es el dato mas importante del panel y es lo unico en `display`.
          En `ok` y no en `accent`: el acento significa "te toca a vos" y esto no
          pide ninguna accion, informa.
        */}
        <p className="code tnum shrink-0 text-display font-semibold text-ok">
          ~US$ {estimate.estimatedUsd}
        </p>
      </CardHeader>

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Dato label="Imágenes" value={String(estimate.imageCount)} />
        <Dato label="Videos IA" value={String(estimate.videoCount)} />
        <Dato label="A filmar" value={String(estimate.realClipCount)} />
        <Dato label="Seg. de video" value={`${estimate.videoSeconds}s`} />
      </dl>

      {estimate.imageVariants > 1 && (
        <p className="mt-2 text-label text-fg-dim">
          <span className="code tnum text-fg">{estimate.baseImages}</span> imágenes ×{" "}
          <span className="code tnum text-fg">{estimate.imageVariants}</span> variantes
          = <span className="code tnum text-fg">{estimate.imageCount}</span>{" "}
          generaciones de imagen.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-t border-divider pt-3 text-label text-fg-dim">
        <span>
          Llamadas:{" "}
          <span className="code tnum text-fg">
            {estimate.imageCount + estimate.videoCount}
          </span>
        </span>
        <span>
          modo <span className="code tnum text-fg">{estimate.providerMode}</span>
        </span>
      </div>

      {/* La nota la escribe la API. `fg-dim` es el piso legible, no baja de ahi. */}
      <p className="mt-2 text-label text-fg-dim">{estimate.note}</p>
    </Card>
  );
}

/** Una celda de la grilla. El valor en mono para que no salte al recalcularse. */
function Dato({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-sm bg-surface-hi px-2.5 py-2">
      <dt className="text-label text-fg-dim">{label}</dt>
      <dd className="code tnum text-title font-semibold text-fg">{value}</dd>
    </div>
  );
}
