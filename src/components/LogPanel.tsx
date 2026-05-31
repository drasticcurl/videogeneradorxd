"use client";
/**
 * Mini-log del pipeline: muestra eventos en vivo (info/exito/aviso/error) con hora.
 */
import type { LogEntry } from "@/lib/types";

const COLOR: Record<string, string> = {
  info: "text-slate-300",
  success: "text-emerald-300",
  warn: "text-amber-300",
  error: "text-red-300",
};

export function LogPanel({ logs }: { logs: LogEntry[] }) {
  const recent = logs.slice(-100).reverse();
  return (
    <div className="rounded-lg border border-slate-700 bg-ink">
      <div className="border-b border-slate-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
        Log del pipeline
      </div>
      <div className="code max-h-64 space-y-0.5 overflow-y-auto p-3 text-[11px] leading-relaxed">
        {recent.length === 0 ? (
          <p className="text-slate-600">Sin eventos todavia…</p>
        ) : (
          recent.map((l, i) => (
            <div key={i} className="flex gap-2">
              <span className="shrink-0 text-slate-600">
                {new Date(l.ts).toLocaleTimeString()}
              </span>
              <span className={COLOR[l.level] ?? "text-slate-300"}>
                {l.level === "error"
                  ? "✗"
                  : l.level === "success"
                  ? "✓"
                  : l.level === "warn"
                  ? "!"
                  : "·"}{" "}
                {l.message}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
