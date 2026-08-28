"use client";
/**
 * Barra superior con los 3 selectores de modelo (Chat / Imagen / Video) + variantes
 * por imagen + resolucion de video. Lee y escribe en el store.
 *
 * Los desplegables son el `Select` de T01 (Radix) y no el `<select>` nativo: las
 * etiquetas del catalogo traen la leyenda en emoji (⚡ rapido, 🧠 mas capaz,
 * 🪙 mas barato) y el desplegable nativo lo dibuja el sistema operativo, en claro y
 * sin poder estilarlo. Ver el comentario de `ui/Select.tsx`.
 *
 * Las etiquetas salen de `MODEL_CATALOG` (`src/lib/config.ts`) tal cual: ese archivo
 * es intocable y aca no se reescribe ni un texto.
 */
import { useProjectStore } from "@/store/useProjectStore";
import { Card, Select, type SelectOption } from "@/components/ui";
import type { ModelOption } from "@/store/useProjectStore";

const VARIANTES = [1, 2, 3, 4] as const;

export function ModelSelectorBar({ disabled = false }: { disabled?: boolean }) {
  const {
    config,
    selectedModels,
    setModel,
    imageVariants,
    setImageVariants,
    defaultResolution,
    setDefaultResolution,
  } = useProjectStore();

  if (!config) return null;

  const resolutions = config.resolutions ?? ["720p", "1080p"];

  return (
    <Card className="flex flex-wrap items-start gap-3">
      <SelectorDeModelo
        label="Chat (interpreta el brief)"
        value={selectedModels.llm}
        options={config.catalog.llm}
        disabled={disabled}
        onChange={(v) => setModel("llm", v)}
      />
      <SelectorDeModelo
        label="Imagen (Nano Banana)"
        value={selectedModels.image}
        options={config.catalog.image}
        disabled={disabled}
        onChange={(v) => setModel("image", v)}
      />
      <SelectorDeModelo
        label="Video (Veo 3.1)"
        value={selectedModels.video}
        options={config.catalog.video}
        disabled={disabled}
        onChange={(v) => setModel("video", v)}
      />

      <Select
        className="w-36 shrink-0"
        label="Variantes por imagen"
        value={String(imageVariants)}
        disabled={disabled}
        // El store guarda number y el Select habla strings: la conversion es de
        // este borde y de nadie mas. `setImageVariants` ya clampea 1-4.
        onValueChange={(v) => setImageVariants(Number(v))}
        options={VARIANTES.map((n) => ({ value: String(n), label: String(n) }))}
      />

      <Select
        className="w-36 shrink-0"
        label="Resolución de video"
        value={defaultResolution}
        disabled={disabled}
        onValueChange={setDefaultResolution}
        options={conFallback(
          resolutions.map((r) => ({ value: r, label: r })),
          defaultResolution,
        )}
      />

      {/*
        Estado del entorno. Va en mono con .tnum porque son valores que cambian con
        el polling de /api/config y en proporcional bailan de ancho (D4).
      */}
      <dl className="ml-auto flex shrink-0 items-center gap-3 self-center text-label text-fg-dim">
        <div className="flex items-center gap-1.5">
          <dt>modo</dt>
          <dd className="code tnum text-fg">{config.providerMode}</dd>
        </div>
        <div className="flex items-center gap-1.5">
          <dt>formato</dt>
          <dd className="code tnum text-fg">9:16</dd>
        </div>
        <div className="flex items-center gap-1.5">
          <dt>ffmpeg</dt>
          <dd className={config.ffmpeg ? "text-ok" : "text-fg-dim"}>
            {config.ffmpeg ? "sí" : "no"}
          </dd>
        </div>
      </dl>
    </Card>
  );
}

/**
 * Un selector de modelo del catalogo.
 *
 * El `hint` es el id real del modelo (`veo-3.1-lite-generate-001`), que es dato que
 * ya viene en el catalogo: no hay ni un texto inventado aca. Sirve porque la etiqueta
 * es comercial ("🪙 Veo 3.1 Lite") y el id es lo que aparece en el log y en el
 * manifest cuando algo sale mal.
 */
function SelectorDeModelo({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: ModelOption[];
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <Select
      className="w-full min-w-[11rem] sm:w-auto sm:flex-1"
      label={label}
      value={value}
      disabled={disabled}
      onValueChange={onChange}
      options={conFallback(
        options.map((o) => ({ value: o.id, label: o.label, hint: o.id })),
        value,
      )}
    />
  );
}

/**
 * Agrega el valor guardado como opcion si no esta en la lista.
 *
 * Es el mismo resguardo que tenia la version con `<select>` nativo, y con Radix es
 * MAS necesario: si el `value` no matchea ningun `Item`, `Select.Value` no renderiza
 * nada y el trigger queda vacio, sin ningun error. Pasa cuando el server cambia el
 * catalogo y el store todavia tiene el modelo viejo persistido.
 */
function conFallback(
  options: SelectOption<string>[],
  value: string,
): SelectOption<string>[] {
  if (!value || options.some((o) => o.value === value)) return options;
  return [...options, { value, label: value, hint: "fuera del catálogo actual" }];
}
