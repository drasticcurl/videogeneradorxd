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
 * `ImagenesTabs` y sus hijos, que son cliente.
 *
 * ─── PantallaFija, NO PantallaScroll ─────────────────────────────────────────
 *
 * Rediseño (handoff `design_handoff_rediseno_augc`): la galeria ya no scrollea de
 * punta a punta. Es una pantalla de TRABAJO (medios 9:16 dimensionados contra el
 * alto real via container queries), asi que le corresponde `PantallaFija` y no
 * `PantallaScroll` como tenia antes — ver el comentario de `@/components/Pantalla`
 * sobre cual usar. El scroll pasa a vivir ADENTRO de cada columna (la lista de
 * tandas del sidebar, el contenido de "Nueva tanda"), nunca en la pagina entera.
 */
import { PantallaFija } from "@/components/Pantalla";
import { MODEL_CATALOG, config } from "@/lib/config";

import ImagenesTabs from "./ImagenesTabs";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Imágenes · AUGC Pipeline",
};

export default function ImagenesPage() {
  return (
    <PantallaFija>
      <ImagenesTabs
        modelos={[...MODEL_CATALOG.image]}
        modeloDefault={config.models.image}
      />
    </PantallaFija>
  );
}
