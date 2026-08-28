"use client";
/**
 * Mini-log del pipeline: eventos en vivo (info / success / warn / error) con hora.
 *
 * El nivel NO tiene un switch de colores propio: `tonoDeLog` de `ui-tokens` traduce
 * el nivel a uno de los cinco tonos del sistema, y aca solo se elige la clase de
 * texto de ese tono. Es la misma escala que usan los badges, asi que un error del log
 * y un job fallado son del mismo rojo.
 *
 * Los timestamps van en mono con `.tnum` (D4): la lista se actualiza con el polling y
 * con fuente proporcional cada hora cambia de ancho y corre el mensaje de al lado.
 */
import { CheckCircle, Info, Warning, XCircle, type Icon } from "@phosphor-icons/react";

import type { LogEntry } from "@/lib/types";
import { tonoDeLog, type Tone } from "@/lib/ui-tokens";

/** Tono -> clase de texto. `neutral` es el nivel `info`, que es la mayoria. */
const TEXTO: Record<Tone, string> = {
  neutral: "text-fg-dim",
  info: "text-info",
  attention: "text-accent",
  ok: "text-ok",
  danger: "text-danger",
};

/**
 * Un icono por nivel, porque antes el nivel se comunicaba SOLO con color y eso es
 * invisible para daltonismo (D5). Reemplaza los glifos ✓ ! ✗ · escritos a mano.
 */
const ICONO: Record<string, Icon> = {
  success: CheckCircle,
  warn: Warning,
  error: XCircle,
};

export function LogPanel({ logs }: { logs: LogEntry[] }) {
  // Igual que antes: los ultimos 100, el mas nuevo arriba.
  const recent = logs.slice(-100).reverse();

  return (
    <section className="overflow-hidden rounded-lg bg-surface">
      <h2 className="border-b border-divider px-3 py-2 text-label font-semibold uppercase tracking-wide text-fg-dim">
        Log del pipeline
      </h2>
      {recent.length === 0 ? (
        <p className="px-3 py-6 text-body text-fg-dim">
          Sin eventos todavía. Cuando arranque la generación el detalle de cada job
          aparece acá.
        </p>
      ) : (
        <ol
          className="max-h-64 divide-y divide-divider overflow-y-auto"
          aria-live="polite"
          aria-label="Eventos del pipeline"
        >
          {recent.map((l, i) => {
            const tono = tonoDeLog(l.level);
            const Icono = ICONO[l.level] ?? Info;
            return (
              <li key={i} className="flex items-start gap-2 px-3 py-1.5 text-label">
                <time
                  dateTime={l.ts}
                  className="code tnum shrink-0 pt-px text-fg-dim"
                >
                  {new Date(l.ts).toLocaleTimeString()}
                </time>
                <Icono
                  aria-hidden
                  className={`mt-0.5 size-3.5 shrink-0 ${TEXTO[tono]}`}
                />
                <span className={`min-w-0 break-words ${TEXTO[tono]}`}>
                  {l.message}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
