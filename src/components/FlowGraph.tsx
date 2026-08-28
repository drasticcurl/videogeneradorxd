"use client";
/**
 * Vista "flujo agentico": la cadena en etapas (columnas) con un nodo por job,
 * conectadas por flechas, resaltando lo que esta corriendo o esperando aprobacion.
 *
 * ─── MIGRACION A TOKENS, MISMA ESTRUCTURA ────────────────────────────────────
 *
 * Ver P-03 del plan: este componente puede no valer la pena con el VSL real, y eso se
 * decide con un dato, no de prepo. Asi que se migro a los tokens nuevos SIN cambiar la
 * estructura: las mismas tres columnas, los mismos dos StageBox, las mismas cuatro
 * flechas y un nodo por job. Ni se agrego scroll vertical ni se colapso nada.
 *
 * El dato quedo medido y anotado en §10 del plan: con `vsl-natalia-plan.json`
 * (95 clips) son 119 nodos de job, 95 de ellos apilados en la columna "Videos", que
 * mide ~3.000px de alto. El contenedor solo tiene scroll horizontal, asi que esa
 * columna estira la pagina.
 *
 * El color de cada nodo sale de `estadoDeJob` + `Badge`, no de un switch local: era
 * la cuarta copia divergente del mapeo de estados (tenia su propio `DOT` con indigo,
 * amber y red escritos a mano).
 */
import { ArrowRight } from "@phosphor-icons/react";

import { Badge } from "@/components/ui";
import type { JobRecord } from "@/lib/types";
import { estadoDeJob } from "@/lib/ui-tokens";

interface Stage {
  title: string;
  jobs: JobRecord[];
}

export function FlowGraph({ stages }: { stages: Stage[] }) {
  const terminado =
    stages.every((s) => s.jobs.every((j) => j.status === "done")) &&
    stages.some((s) => s.jobs.length > 0);

  return (
    <div className="overflow-x-auto rounded-lg bg-surface p-4">
      <div className="flex min-w-max items-stretch gap-2">
        <StageBox title="Brief → Plan" done />
        {stages.map((stage, i) => (
          <div key={i} className="flex items-stretch gap-2">
            <Flecha />
            <div className="flex w-44 flex-col gap-2 rounded-lg border border-divider bg-bg p-2">
              <h3 className="text-label font-semibold text-fg-dim">{stage.title}</h3>
              {stage.jobs.length === 0 ? (
                <p className="text-label text-fg-dim">—</p>
              ) : (
                stage.jobs.map((j) => <Nodo key={j.id} job={j} />)
              )}
            </div>
          </div>
        ))}
        <Flecha />
        <StageBox title="Listo" done={terminado} />
      </div>
    </div>
  );
}

/**
 * Un job. Es un `Badge` y no un div con clases propias: asi el color del estado sale
 * del mismo lugar que en el resto de la app y este archivo no traduce ni un tono.
 *
 * El texto es la etiqueta del job ("01_hook"), que es un id: va en mono. El estado se
 * lee por el punto de color, y el `title` lo dice con palabras.
 */
function Nodo({ job }: { job: JobRecord }) {
  const estado = estadoDeJob(job.status);
  return (
    // El title va en el envoltorio porque `Badge` no acepta atributos sueltos: su
    // contrato son `tone`, `punto`, `animado` y `className`, y no se cambia (§5).
    <div title={job.error ?? estado.label}>
      <Badge
        tone={estado.tone}
        punto
        animado={estado.animado}
        className="w-full justify-start"
      >
        <span className="code min-w-0 truncate">{job.label}</span>
      </Badge>
    </div>
  );
}

function Flecha() {
  return (
    <div className="flex items-center self-center text-fg-dim">
      <ArrowRight aria-hidden className="size-4" />
    </div>
  );
}

function StageBox({ title, done }: { title: string; done?: boolean }) {
  return (
    <div className="flex w-28 flex-col items-center justify-center rounded-lg border border-divider bg-bg p-2 text-center">
      <span
        aria-hidden
        className={`mb-1 size-2.5 rounded-full ${done ? "bg-ok" : "bg-fg-dim"}`}
      />
      <span className="text-label font-medium text-fg-dim">{title}</span>
    </div>
  );
}
