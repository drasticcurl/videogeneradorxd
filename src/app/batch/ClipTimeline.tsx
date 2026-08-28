"use client";
/**
 * Linea de tiempo de un proyecto: todos los clips en orden, con su estado.
 * Se muestra en el tablero cuando el proyecto pasa a fase VIDEOS, asi ves de un
 * vistazo como se va llenando el video completo.
 *
 * Cada bloque tiene el ancho proporcional a su duracion (4/6/8s) y el frame
 * inicial como fondo. Al clickear, se abre el clip generado en una pestaña nueva.
 *
 * ─── QUE CAMBIO EN EL REDISEÑO Y QUE NO ──────────────────────────────────────
 *
 * T07 tenia instruccion explicita de MIGRAR ESTE ARCHIVO A TOKENS SIN CAMBIARLE LA
 * ESTRUCTURA. Asi que la tira sigue siendo una tira: mismo alto, mismo ancho
 * proporcional a la duracion, mismo `overflow-x-auto`, mismo click al video.
 *
 * Lo unico que cambio:
 *   - los siete colores literales (emerald/amber/indigo/red/slate) salen ahora del
 *     tono que devuelve `estadoDeJob`, o sea del mismo mapeo que los badges;
 *   - el numero de orden estaba en 9px y el encabezado en 10px: los dos subieron a
 *     `text-label` (12px), que es el piso de la escala (§4);
 *   - el tooltip mostraba el `status` CRUDO ("awaiting_approval") en la cara del
 *     usuario, que es justo lo que §6 regla 2 prohibe. Ahora muestra el label en
 *     castellano.
 *
 * NO se rediseño la estructura, y con el VSL real de 95 clips no alcanza: ver P-17
 * en §10 del plan, con el numero medido a partir del cual deja de ser usable.
 */
import type { BatchTimelineItem } from "@/lib/batch";
import { cn } from "@/lib/cn";
import { estadoDeJob, type Tone } from "@/lib/ui-tokens";

/**
 * Tono -> borde y relleno del bloque. Es el mismo patron que `LogPanel` y `JobCard`:
 * el ESTADO se traduce a tono en `ui-tokens` y aca solo se elige la clase de ese
 * tono. Ni un color literal, y el mismo estado sale del mismo color que su badge.
 */
const BLOQUE: Record<Tone, string> = {
  neutral: "border-divider bg-surface-hi",
  info: "border-info bg-info/20",
  attention: "border-accent bg-accent/20",
  ok: "border-ok bg-ok/20",
  danger: "border-danger bg-danger/20",
};

export function ClipTimeline({
  items,
  totalSeconds,
}: {
  items: BatchTimelineItem[];
  totalSeconds: number;
}) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-label text-fg-dim">
        <span>
          Línea de tiempo · <span className="code tnum text-fg">{items.length}</span>{" "}
          clips
        </span>
        <span className="code tnum">{formatDuration(totalSeconds)}</span>
      </div>
      <div className="flex gap-0.5 overflow-x-auto pb-1">
        {items.map((it) => {
          // `placeholder` es un clip FILMAR_REAL: no lo genera la IA, lo grabás vos.
          // No es un estado de job y `ui-tokens` no lo mapea (P-05), asi que se le da
          // el mismo tono que le da `StatusBadge` —attention, porque requiere al
          // usuario— y el borde punteado, que es lo que lo distingue de un clip que
          // la IA todavia no empezo.
          const esPlaceholder = it.status === "placeholder";
          const estado = esPlaceholder
            ? { tone: "attention" as Tone, label: "A filmar", animado: false }
            : estadoDeJob(it.status);

          const clases = cn(
            "relative flex h-9 shrink-0 items-center justify-center overflow-hidden rounded-sm border",
            BLOQUE[estado.tone],
            esPlaceholder && "border-dashed",
            estado.animado && "motion-safe:animate-pulse",
          );

          // El label crudo del status ya no se muestra: va el de `ui-tokens`.
          const label = `${it.label} · ${it.duracionSeg}s · ${estado.label}${
            it.dialogo ? `\n"${it.dialogo}"` : ""
          }${it.error ? `\n${it.error}` : ""}`;

          const content = (
            <>
              {it.imageUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={it.imageUrl}
                  alt=""
                  aria-hidden
                  className="absolute inset-0 h-full w-full object-cover opacity-30"
                />
              )}
              <span className="code tnum relative z-10 text-label font-medium text-fg">
                {it.orden}
              </span>
            </>
          );
          // Ancho proporcional a la duracion (4s = 16px, 8s = 32px aprox).
          const width = Math.max(14, it.duracionSeg * 4);
          return it.videoUrl ? (
            <a
              key={it.clipId}
              href={it.videoUrl}
              target="_blank"
              rel="noreferrer"
              title={label}
              // Sin esto el nombre accesible del link es solo el numero de orden.
              aria-label={`Clip ${it.orden}: ${estado.label}. Abrir el video.`}
              style={{ width }}
              className={cn(
                clases,
                "transition-opacity hover:opacity-80",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
              )}
            >
              {content}
            </a>
          ) : (
            <span
              key={it.clipId}
              title={label}
              style={{ width }}
              className={clases}
            >
              {content}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
