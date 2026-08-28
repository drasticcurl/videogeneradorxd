/**
 * Pantalla de solo imagenes.
 *
 * El catalogo de modelos se resuelve en el SERVER y baja como prop, en vez de que el
 * cliente lo pida a /api/config: asi el selector nunca se pinta vacio ni con un
 * modelo que no existe mientras espera el fetch.
 *
 * ─── POR QUE NO HAY NI UN ICONO EN ESTE ARCHIVO ──────────────────────────────
 *
 * Es un Server Component y `@phosphor-icons/react` 2.1.10 no declara "use client"
 * en su `dist` (verificado): usa `createContext` para el `IconContext`, asi que
 * importarlo desde el server revienta el build. Los iconos de esta pantalla viven en
 * `ImagenesBoard`, que si es cliente.
 */
import { MODEL_CATALOG, config } from "@/lib/config";

import ImagenesBoard from "./ImagenesBoard";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Imágenes · AUGC Pipeline",
};

export default function ImagenesPage() {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-display font-semibold text-fg">Imágenes</h1>
        <p className="mt-1 max-w-prose text-body text-fg-dim">
          Un prompt por proyecto, sin video. Elegís formato y calidad, sale con las
          variantes que pidas y podés variarlas sin volver a empezar.
        </p>
      </header>

      <ImagenesBoard
        modelos={[...MODEL_CATALOG.image]}
        modeloDefault={config.models.image}
      />
    </div>
  );
}
