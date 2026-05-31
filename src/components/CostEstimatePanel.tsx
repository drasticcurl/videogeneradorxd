"use client";
import type { CostEstimate } from "@/store/useProjectStore";

export function CostEstimatePanel({ estimate }: { estimate: CostEstimate }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-panel p-4 text-sm">
      <h3 className="mb-2 font-semibold text-slate-200">Estimacion antes de generar</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Imagenes" value={`${estimate.imageCount}`} />
        <Stat label="Videos IA" value={String(estimate.videoCount)} />
        <Stat label="A filmar" value={String(estimate.realClipCount)} />
        <Stat label="Seg. de video" value={`${estimate.videoSeconds}s`} />
      </div>
      {estimate.imageVariants > 1 && (
        <p className="mt-2 text-xs text-slate-400">
          {estimate.baseImages} imagenes × {estimate.imageVariants} variantes ={" "}
          {estimate.imageCount} generaciones de imagen.
        </p>
      )}
      <div className="mt-3 flex items-center justify-between border-t border-slate-700 pt-3">
        <span className="text-slate-400">
          Llamadas: {estimate.imageCount + estimate.videoCount} ·{" "}
          modo <code className="text-slate-200">{estimate.providerMode}</code>
        </span>
        <span className="text-lg font-semibold text-emerald-300">
          ~ US$ {estimate.estimatedUsd}
        </span>
      </div>
      <p className="mt-2 text-xs text-slate-500">{estimate.note}</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-ink p-2">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="text-lg font-semibold text-slate-100">{value}</div>
    </div>
  );
}
