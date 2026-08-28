/**
 * Pantalla de solo imagenes.
 *
 * El catalogo de modelos se resuelve en el SERVER y baja como prop, en vez de que el
 * cliente lo pida a /api/config: asi el selector nunca se pinta vacio ni con un
 * modelo que no existe mientras espera el fetch.
 */
import { MODEL_CATALOG, config } from "@/lib/config";

import ImagenesBoard from "./ImagenesBoard";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Imágenes · AUGC Pipeline",
};

export default function ImagenesPage() {
  return (
    <div>
      <h1 className="text-lg font-semibold">Imágenes</h1>
      <p className="mt-1 text-sm text-slate-400">
        Pegás prompts y genera imágenes, sin video. Cada prompt sale con las
        variantes que elijas y podés variar cualquiera sin tocar el resto.
      </p>
      <div className="mt-5">
        <ImagenesBoard
          modelos={[...MODEL_CATALOG.image]}
          modeloDefault={config.models.image}
        />
      </div>
    </div>
  );
}
