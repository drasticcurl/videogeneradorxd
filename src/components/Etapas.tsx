"use client";

/**
 * La fila de "Etapas" del pipeline de un proyecto, y el aviso de aprobacion.
 *
 * ─── POR QUE REEMPLAZA A FlowGraph ───────────────────────────────────────────
 *
 * `FlowGraph` dibuja un nodo por job en columnas: con el VSL real (95 clips) la
 * columna de videos mide ~2.700px de alto (medido en P-03 del plan viejo) y el
 * grafo entero queda ilegible. Esto es lo que el handoff pide en su lugar: una fila
 * de 5 cards con el contador "hechos/total" y una barra de 4px. Se lee en un
 * segundo, no importa si el proyecto tiene 6 clips o 95.
 *
 * Las 5 etapas son fijas y no vienen de `groups` (t2i/i2i/vids) porque el handoff
 * pide separar "Imagenes base" de "Imagenes derivadas" aunque las dos sean type
 * "image": son pasos distintos del plan (la base es la identidad, la derivada usa
 * esa identidad), y juntarlas en una sola card le esconde al usuario en cual de las
 * dos etapas esta el problema si una se atasca.
 *
 * El color de la barra es SOLO ok o info, nunca el tono de un job individual: acá se
 * resume una etapa entera, no un job, y `estadoDeJob` no tiene una nocion de "listo
 * en conjunto". `ok` si terminaron todos, `info` si hay alguno corriendo o esta
 * incompleta, gris (`neutral`, via bg-surface-hi vacio) si todavia no arranco nada.
 */
import { CursorClick } from "@phosphor-icons/react";

import { Badge, Button } from "@/components/ui";
import { cn } from "@/lib/cn";

export interface EtapaResumen {
  label: string;
  hechos: number;
  total: number;
}

/**
 * Una fila con las 5 cards `flex: 1 0 140px`, como pide el handoff. `overflow-x-auto`
 * para que en una ventana angosta scrollee en vez de aplastar las cards a un ancho
 * ilegible (140px es el minimo, no el maximo).
 */
export function EtapasFila({ etapas }: { etapas: EtapaResumen[] }) {
  return (
    <div className="flex items-stretch gap-1 overflow-x-auto">
      {etapas.map((e) => (
        <EtapaCard key={e.label} etapa={e} />
      ))}
    </div>
  );
}

function EtapaCard({ etapa }: { etapa: EtapaResumen }) {
  const { label, hechos, total } = etapa;
  // "listo" es un caso aparte y no `b===1` a secas: una etapa con total=0 (por
  // ejemplo "Imagenes derivadas" en un plan sin image2image) no arranco ni termino,
  // y pintarla verde diria "listo" de algo que nunca existio.
  const listo = total > 0 && hechos >= total;
  const enCurso = total > 0 && hechos < total && hechos > 0;
  const pct = total > 0 ? Math.round((hechos / total) * 100) : 0;
  const txt = total === 1 ? (hechos >= total ? "listo" : "—") : `${hechos}/${total}`;

  return (
    <div className="flex flex-[1_0_140px] flex-col gap-1.5 rounded-md bg-surface p-2.5">
      <div className="flex items-center justify-between gap-2 text-label">
        <span className="truncate text-fg-dim">{label}</span>
        <span className="code tnum shrink-0 text-fg">{txt}</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-sm bg-surface-hi">
        <div
          className={cn(
            "h-full rounded-sm transition-[width]",
            listo ? "bg-ok" : enCurso ? "bg-info" : "bg-surface-hi",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/**
 * El aviso accent/10 de clips esperando aprobacion, con las dos salidas: revisar de a
 * uno (manda a la vista de arreglo/revision) o aprobar todo el lote de una.
 *
 * Es un componente aparte y no parte de `EtapasFila` porque su presencia es
 * condicional (`awaiting > 0`) y las dos pantallas que lo usan (pipeline) ya tienen
 * el numero calculado distinto: separarlo evita que este archivo tenga que saber de
 * donde saca el conteo.
 */
export function AvisoAprobacion({
  cantidad,
  onRevisar,
  onAprobarTodos,
}: {
  cantidad: number;
  onRevisar: () => void;
  onAprobarTodos: () => void;
}) {
  if (cantidad <= 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg bg-accent/10 px-3 py-2.5">
      <CursorClick aria-hidden className="size-5 shrink-0 text-accent" />
      <p className="min-w-[200px] flex-1 text-body">
        <span className="font-medium text-fg">
          <span className="tnum">{cantidad}</span>{" "}
          {cantidad === 1 ? "clip espera" : "clips esperan"} tu aprobación.
        </span>{" "}
        <span className="text-label text-fg-dim">
          La cola sigue cuando los apruebes.
        </span>
      </p>
      <Button
        size="sm"
        variant="secondary"
        className="border-accent text-accent hover:bg-accent/10"
        onClick={onRevisar}
      >
        Revisar uno por uno
      </Button>
      <Button size="sm" variant="primary" onClick={onAprobarTodos}>
        Aprobar todos
      </Button>
    </div>
  );
}

/** Para reusar el mismo Badge de "esperando" en headers, sin repetir el tone a mano. */
export function BadgeEsperando({ cantidad }: { cantidad: number }) {
  if (cantidad <= 0) return null;
  return (
    <Badge tone="attention" punto>
      <span className="tnum">{cantidad}</span> esperando que aprobés
    </Badge>
  );
}
