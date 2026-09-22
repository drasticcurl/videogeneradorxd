/**
 * Los dos contenedores de pantalla. Uno de los dos va SIEMPRE como raiz de una
 * pagina, porque `layout.tsx` ya no trae max-width ni padding y el body es
 * `overflow-hidden`: una pagina que no use ninguno y mida mas que el viewport queda
 * cortada, sin ningun error.
 *
 * ─── CUAL DE LOS DOS ─────────────────────────────────────────────────────────
 *
 * `PantallaFija` para las pantallas de TRABAJO: galeria de imagenes, pipeline de un
 * proyecto, revisar. Son las que muestran medios 9:16 y se dimensionan contra el
 * alto real disponible con container queries. El scroll va adentro de cada columna.
 *
 * `PantallaScroll` para las de LISTADO y FORMULARIO: proyectos, tablero, wizard.
 * Ahi el contenido crece de forma imprevisible (un VSL tiene 95 clips) y pelearle
 * al alto con container queries no aporta nada.
 */
import { cn } from "@/lib/cn";

/**
 * Columna de alto fijo. No scrollea: sus hijos se reparten el alto y el que
 * necesite scroll se lo pone con `min-h-0 flex-1 overflow-y-auto`.
 */
export function PantallaFija({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", className)}>
      {children}
    </div>
  );
}

/**
 * Contenido que scrollea, con el ancho maximo de siempre.
 *
 * El `overflow-y-auto` va en el contenedor de AFUERA y el max-width en el de
 * adentro. Al revés, la barra de scroll aparece en el medio de la pantalla en un
 * monitor ancho, en el borde de los 1400px, que es donde nadie la busca.
 */
export function PantallaScroll({
  ancho = "1400px",
  className,
  children,
}: {
  /** Ancho maximo del contenido. `full` para ocupar todo. */
  ancho?: "1400px" | "1080px" | "full";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div
        className={cn(
          "w-full px-4 py-6 sm:px-6",
          ancho === "1400px" && "max-w-[1400px]",
          ancho === "1080px" && "max-w-[1080px]",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Barra de acciones pegada abajo, afuera del scroll. La usan los formularios
 * (Nueva tanda, Masivo, el wizard): el boton de "Generar" es lo que el usuario vino
 * a apretar y no puede estar a 800px de scroll de distancia.
 */
export function BarraInferior({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-none flex-wrap items-center gap-3 border-t border-divider px-4 py-3 sm:px-6",
        className,
      )}
    >
      {children}
    </div>
  );
}
