"use client";
/**
 * Vista "flujo agentico": muestra la cadena en etapas (columnas) con nodos por job,
 * conectadas por flechas, resaltando lo que esta corriendo / esperando aprobacion.
 */
import type { JobRecord, JobStatus } from "@/lib/types";

const DOT: Record<JobStatus, string> = {
  pending: "bg-slate-500",
  generating: "bg-amber-400 animate-pulse",
  awaiting_approval: "bg-indigo-400",
  done: "bg-emerald-400",
  failed: "bg-red-400",
};

interface Stage {
  title: string;
  jobs: JobRecord[];
}

export function FlowGraph({ stages }: { stages: Stage[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-700 bg-panel p-4">
      <div className="flex min-w-max items-stretch gap-2">
        <StageBox title="Brief → Plan" done />
        {stages.map((stage, i) => (
          <div key={i} className="flex items-stretch gap-2">
            <Arrow />
            <div className="flex w-44 flex-col gap-2 rounded-lg border border-slate-800 bg-ink p-2">
              <div className="text-xs font-semibold text-slate-300">{stage.title}</div>
              {stage.jobs.length === 0 ? (
                <div className="text-[11px] text-slate-600">—</div>
              ) : (
                stage.jobs.map((j) => (
                  <div
                    key={j.id}
                    className={`flex items-center gap-2 rounded px-2 py-1 text-[11px] ${
                      j.status === "generating"
                        ? "bg-amber-500/10"
                        : j.status === "awaiting_approval"
                        ? "bg-indigo-500/10"
                        : j.status === "failed"
                        ? "bg-red-500/10"
                        : "bg-slate-800/40"
                    }`}
                    title={j.error ?? j.status}
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[j.status]}`} />
                    <span className="truncate text-slate-200">{j.label}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        ))}
        <Arrow />
        <StageBox
          title="Listo"
          done={stages.every((s) => s.jobs.every((j) => j.status === "done")) &&
            stages.some((s) => s.jobs.length > 0)}
        />
      </div>
    </div>
  );
}

function Arrow() {
  return (
    <div className="flex items-center self-center text-slate-600">
      <span className="text-lg">→</span>
    </div>
  );
}

function StageBox({ title, done }: { title: string; done?: boolean }) {
  return (
    <div className="flex w-28 flex-col items-center justify-center rounded-lg border border-slate-800 bg-ink p-2 text-center">
      <span
        className={`mb-1 h-2.5 w-2.5 rounded-full ${
          done ? "bg-emerald-400" : "bg-slate-600"
        }`}
      />
      <span className="text-[11px] font-medium text-slate-300">{title}</span>
    </div>
  );
}
