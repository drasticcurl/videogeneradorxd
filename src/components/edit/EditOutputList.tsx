"use client";
/**
 * EditOutputList — Lists completed edit outputs for a project.
 *
 * Fetches from GET /api/edit and displays completed outputs with
 * preview/download links.
 *
 * Requirements: 6.3, 6.4
 */
import { useEffect, useState } from "react";

interface EditOutput {
  id: string;
  status: string;
  outputKey: string | null;
  createdAt: string;
  updatedAt: string;
}

interface EditOutputListProps {
  projectId: string;
}

export function EditOutputList({ projectId }: EditOutputListProps) {
  const [outputs, setOutputs] = useState<EditOutput[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const res = await fetch(`/api/edit?projectId=${projectId}`);
        if (res.ok && active) {
          const data = await res.json();
          setOutputs(data.jobs ?? []);
        }
      } catch {
        // Ignore errors
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => { active = false; };
  }, [projectId]);

  if (loading) {
    return (
      <div className="text-xs text-slate-500 py-2">Cargando ediciones...</div>
    );
  }

  const completedOutputs = outputs.filter((o) => o.status === "completed");

  if (completedOutputs.length === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border border-slate-700 bg-panel p-4 space-y-3">
      <h3 className="text-sm font-semibold text-slate-300 uppercase tracking-wide">
        Ediciones completadas ({completedOutputs.length})
      </h3>
      <div className="space-y-2">
        {completedOutputs.map((output) => (
          <div
            key={output.id}
            className="flex items-center justify-between rounded-md border border-slate-700 bg-ink px-3 py-2"
          >
            <div className="space-y-0.5">
              <div className="text-xs text-slate-200 font-mono">{output.id}</div>
              <div className="text-[11px] text-slate-500">
                {new Date(output.updatedAt).toLocaleString()}
              </div>
            </div>
            <a
              href={`/api/edit/${output.id}/result`}
              className="rounded-md border border-emerald-600/60 px-3 py-1 text-xs text-emerald-200 hover:bg-emerald-500/10"
            >
              Descargar
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}
