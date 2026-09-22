"use client";

/**
 * Control segmentado: pastilla sobre fondo `surface`, la activa en `surface-hi`.
 *
 * ─── POR QUE NO ES `Tabs` ────────────────────────────────────────────────────
 *
 * `Tabs` (Radix) es subrayado y va arriba de un panel de contenido: dice "estas
 * mirando una parte de esto". El segmentado dice "elegiste UN modo de ver lo mismo",
 * y el rediseño lo pide en cinco lugares donde no hay panel debajo: Generar/Masivo
 * en el sidebar de imagenes, Grilla/Visor, Pipeline/Resultado, Imagenes/Clips en
 * revisar, y Brief con IA / Pegar PlanJSON en el wizard.
 *
 * Es `radiogroup` y no `tablist`: no hay ningun `tabpanel` asociado, y anunciar
 * pestañas que no existen le miente al lector de pantalla. Las flechas las maneja el
 * navegador solo con los radios nativos... pero acá son botones (hace falta poder
 * poner un icono y un `title`), asi que las flechas se manejan a mano abajo.
 */

import { cn } from "@/lib/cn";

export interface OpcionSegmentada<T extends string> {
  value: T;
  label: React.ReactNode;
  /** Para el `title` y el nombre accesible cuando el label es solo un icono. */
  titulo?: string;
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  etiqueta,
  tamanio = "md",
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<OpcionSegmentada<T>>;
  /** Nombre accesible del grupo. Obligatorio: son controles sin label visible. */
  etiqueta: string;
  /** `sm` para los toggles de solo icono (28px), `md` para los de texto (32px). */
  tamanio?: "sm" | "md";
  className?: string;
}) {
  const i = options.findIndex((o) => o.value === value);

  function alTeclado(e: React.KeyboardEvent) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const paso = e.key === "ArrowRight" ? 1 : -1;
    // Circular: en un grupo de dos opciones, que la flecha se "trabe" en el extremo
    // obliga a apretar la otra flecha para volver, que es exactamente el gesto que
    // el usuario ya hizo.
    const siguiente = options[(i + paso + options.length) % options.length];
    onChange(siguiente.value);
  }

  return (
    <div
      role="radiogroup"
      aria-label={etiqueta}
      onKeyDown={alTeclado}
      className={cn(
        "inline-flex flex-none gap-0.5 rounded-md bg-surface",
        tamanio === "sm" ? "p-0.5" : "p-[3px]",
        className,
      )}
    >
      {options.map((o) => {
        const activa = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={activa}
            title={o.titulo}
            aria-label={o.titulo}
            // Solo la opcion activa es tabulable: con las cinco en el orden de
            // tabulacion, llegar al contenido de la galeria costaba cuatro tabs mas.
            tabIndex={activa ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex items-center justify-center gap-1.5 rounded-sm font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
              tamanio === "sm" ? "size-7 text-label" : "h-7 px-3 text-body",
              activa
                ? "bg-surface-hi text-fg"
                : "bg-transparent text-fg-dim hover:text-fg",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
