"use client";

/**
 * Shell de /imagenes: el grid `272px | 1fr` a alto completo (sidebar + resultados) y
 * el segmented "Generar / Masivo" que decide cual de las dos pestañas se monta.
 *
 * ─── POR QUE EL GRID VIVE ACA Y NO ADENTRO DE CADA PESTAÑA ───────────────────
 *
 * El sidebar (segmented + botón "Nueva tanda" + lista de tandas) es la MISMA
 * columna para las dos pestañas, solo cambia que lista muestra adentro. Si cada
 * pestaña armara su propio `<aside>`, el segmented Generar/Masivo tendria que vivir
 * duplicado en los dos (o subir un nivel mas), y ya esta acá. Por eso `ImagenesBoard`
 * y `GeneradorMasivo` reciben `activo`/`onCambiarTab` y devuelven SOLO el contenido
 * de su columna de sidebar (la lista de tandas) y su columna principal, en vez de
 * armar el `<aside>` completo.
 *
 * ─── SEGUIMOS SIN CONTROLAR LA PESTAÑA POR LA URL ────────────────────────────
 *
 * Mismo motivo que antes del rediseño: las dos pestañas viven en la MISMA ruta
 * `/imagenes` y `?id=` ya identifica el proyecto abierto en la pestaña Generar. Un
 * segundo parametro para la pestaña no aporta nada (ver el comentario que tenia el
 * archivo viejo) y ahora hay un tercer estado en juego (`vista: 'galeria' | 'nueva'`
 * dentro de Generar) que tampoco necesita ser un link compartible.
 */
import { Plus, Sparkle, StackSimple } from "@phosphor-icons/react";
import { useState } from "react";

import { Button, Segmented } from "@/components/ui";
import type { ModelOption } from "@/lib/config";

import GeneradorMasivo from "./GeneradorMasivo";
import ImagenesBoard from "./ImagenesBoard";

type Tab = "generar" | "masivo";

export default function ImagenesTabs({
  modelos,
  modeloDefault,
}: {
  modelos: ModelOption[];
  modeloDefault: string;
}) {
  const [tab, setTab] = useState<Tab>("generar");

  return (
    <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: "272px minmax(0, 1fr)" }}>
      {tab === "generar" ? (
        <ImagenesBoard
          modelos={modelos}
          modeloDefault={modeloDefault}
          tab={tab}
          onCambiarTab={setTab}
        />
      ) : (
        <GeneradorMasivo tab={tab} onCambiarTab={setTab} />
      )}
    </div>
  );
}

/**
 * El segmented + "Nueva tanda" de arriba del sidebar. Se exporta para que las dos
 * pestañas lo compartan tal cual (mismos textos, mismo tamaño) sin duplicar el JSX.
 */
export function CabeceraSidebar({
  tab,
  onCambiarTab,
  onNuevaTanda,
  labelNueva,
}: {
  tab: Tab;
  onCambiarTab: (t: Tab) => void;
  onNuevaTanda: () => void;
  labelNueva: string;
}) {
  return (
    <div className="flex flex-none flex-col gap-3 p-4 pb-3">
      <Segmented
        etiqueta="Pestaña de imágenes"
        value={tab}
        onChange={onCambiarTab}
        options={[
          {
            value: "generar",
            label: (
              <span className="inline-flex items-center gap-1.5">
                <Sparkle aria-hidden className="size-3.5" />
                Generar
              </span>
            ),
          },
          {
            value: "masivo",
            label: (
              <span className="inline-flex items-center gap-1.5">
                <StackSimple aria-hidden className="size-3.5" />
                Masivo
              </span>
            ),
          },
        ]}
      />
      <Button
        variant="primary"
        size="md"
        onClick={onNuevaTanda}
        icon={<Plus aria-hidden className="size-4" />}
        className="w-full"
      >
        {labelNueva}
      </Button>
    </div>
  );
}

export type { Tab };
