"use client";
/**
 * Linea de tiempo de un proyecto: todos los clips en orden, con su estado.
 * Se muestra en el tablero cuando el proyecto pasa a fase VIDEOS, asi ves de un
 * vistazo como se va llenando el video completo.
 *
 * Cada bloque tiene el ancho proporcional a su duracion (4/6/8s) y el frame
 * inicial como fondo. Al clickear, se abre el clip generado en una pestaña nueva.
 */
import type { BatchTimelineItem } from "@/lib/batch";

const STATUS_STYLE: Record<string, string> = {
  done: "border-emerald-500 bg-emerald-500/20",
  generating: "border-amber-400 bg-amber-400/20 animate-pulse",
  awaiting_approval: "border-indigo-400 bg-indigo-400/20",
  failed: "border-red-500 bg-red-500/20",
  pending: "border-slate-700 bg-slate-800/60",
  placeholder: "border-dashed border-slate-600 bg-slate-800/40",
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
      <div className="flex items-center justify-between text-[10px] text-slate-500">
        <span>Linea de tiempo · {items.length} clips</span>
        <span>{formatDuration(totalSeconds)}</span>
      </div>
      <div className="flex gap-0.5 overflow-x-auto pb-1">
        {items.map((it) => {
          const style = STATUS_STYLE[it.status] ?? STATUS_STYLE.pending;
          const label = `${it.label} · ${it.duracionSeg}s · ${it.status}${
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
              <span className="relative z-10 text-[9px] font-medium text-slate-200">
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
              style={{ width }}
              className={`relative flex h-9 shrink-0 items-center justify-center overflow-hidden rounded border ${style} hover:opacity-80`}
            >
              {content}
            </a>
          ) : (
            <span
              key={it.clipId}
              title={label}
              style={{ width }}
              className={`relative flex h-9 shrink-0 items-center justify-center overflow-hidden rounded border ${style}`}
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
