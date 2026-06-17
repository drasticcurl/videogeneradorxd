"use client";
/**
 * Barra superior con los 3 selectores de modelo (Chat / Imagen / Video) + variantes.
 * Lee y escribe en el store. La cantidad de variantes solo aplica a imagenes.
 */
import { useProjectStore } from "@/store/useProjectStore";

export function ModelSelectorBar({ disabled = false }: { disabled?: boolean }) {
  const {
    config,
    selectedModels,
    setModel,
    imageVariants,
    setImageVariants,
    defaultResolution,
    setDefaultResolution,
    refreshModels,
  } = useProjectStore();

  if (!config) return null;

  const resolutions = config.resolutions ?? ["720p", "1080p"];

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-700 bg-panel px-4 py-3">
      <Select
        label="Chat (interpreta el brief)"
        value={selectedModels.llm}
        options={config.catalog.llm}
        disabled={disabled}
        onChange={(v) => setModel("llm", v)}
      />
      <Select
        label="Imagen (Nano Banana)"
        value={selectedModels.image}
        options={config.catalog.image}
        disabled={disabled}
        onChange={(v) => setModel("image", v)}
      />
      <Select
        label="Video (Veo 3.1)"
        value={selectedModels.video}
        options={config.catalog.video}
        disabled={disabled}
        onChange={(v) => setModel("video", v)}
      />
      <div className="flex flex-col gap-1">
        <label className="text-xs text-slate-400">Variantes por imagen</label>
        <select
          disabled={disabled}
          value={imageVariants}
          onChange={(e) => setImageVariants(Number(e.target.value))}
          className="rounded-md border border-slate-600 bg-ink px-2 py-1.5 text-sm focus:border-accent focus:outline-none disabled:opacity-50"
        >
          {[1, 2, 3, 4].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-slate-400">Resolucion video (default)</label>
        <select
          disabled={disabled}
          value={defaultResolution}
          onChange={(e) => setDefaultResolution(e.target.value)}
          className="rounded-md border border-slate-600 bg-ink px-2 py-1.5 text-sm focus:border-accent focus:outline-none disabled:opacity-50"
        >
          {resolutions.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      <div className="ml-auto flex items-center gap-2 self-center text-xs text-slate-400">
        <span>
          modo <b className="text-slate-100">{config.providerMode}</b>
        </span>
        <span>· 9:16</span>
        <span>
          · modelos:{" "}
          <b className="text-slate-100">
            {config.catalogSource === "vertex" ? "Vertex" : "catálogo"}
          </b>
        </span>
        <button
          type="button"
          onClick={() => void refreshModels()}
          disabled={disabled}
          title="Volver a consultar los modelos disponibles en Vertex AI"
          className="rounded border border-slate-600 px-2 py-0.5 text-[11px] hover:bg-slate-800 disabled:opacity-40"
        >
          ↻ modelos
        </button>
      </div>
    </div>
  );
}

function Select({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: { id: string; label: string }[];
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex min-w-[10rem] flex-col gap-1">
      <label className="text-xs text-slate-400">{label}</label>
      <select
        disabled={disabled}
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "__manual__") {
            const manual = window.prompt("Escribí el ID exacto del modelo:", value);
            if (manual && manual.trim()) onChange(manual.trim());
            return;
          }
          onChange(v);
        }}
        className="rounded-md border border-slate-600 bg-ink px-2 py-1.5 text-sm focus:border-accent focus:outline-none disabled:opacity-50"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
        {/* por si el valor guardado no esta en el catalogo */}
        {!options.some((o) => o.id === value) && (
          <option value={value}>{value}</option>
        )}
        {/* permite tipear un ID que no este en la lista */}
        <option value="__manual__">✎ otro ID…</option>
      </select>
    </div>
  );
}
