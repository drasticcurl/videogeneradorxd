"use client";
import type { JobStatus } from "@/lib/types";

type Status = JobStatus | "placeholder" | "draft" | "running" | "partial";

const MAP: Record<string, { label: string; cls: string }> = {
  pending: { label: "pendiente", cls: "bg-slate-700 text-slate-200" },
  generating: { label: "generando…", cls: "bg-amber-500/20 text-amber-300 animate-pulse" },
  done: { label: "listo", cls: "bg-emerald-500/20 text-emerald-300" },
  failed: { label: "error", cls: "bg-red-500/20 text-red-300" },
  placeholder: { label: "a filmar", cls: "bg-fuchsia-500/20 text-fuchsia-300" },
  draft: { label: "borrador", cls: "bg-slate-700 text-slate-200" },
  running: { label: "en curso", cls: "bg-amber-500/20 text-amber-300" },
  partial: { label: "parcial", cls: "bg-orange-500/20 text-orange-300" },
};

export function StatusBadge({ status }: { status: Status }) {
  const m = MAP[status] ?? { label: status, cls: "bg-slate-700 text-slate-200" };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${m.cls}`}
    >
      {m.label}
    </span>
  );
}
