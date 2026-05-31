"use client";
import { StatusBadge } from "./StatusBadge";
import type { JobRecord } from "@/lib/types";

interface Props {
  job: JobRecord;
  projectId: string;
  onRetry: (jobId: string) => void;
}

export function JobCard({ job, projectId, onRetry }: Props) {
  const fileUrl = job.outputPath
    ? `/api/files/${projectId}/${job.outputPath}`
    : null;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-slate-700 bg-panel p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-slate-100">
            {job.label}
          </div>
          <div className="text-xs text-slate-500">
            {job.type === "image" ? "imagen" : "video"}
            {job.attempts > 0 && ` · intento ${job.attempts}/${job.maxAttempts}`}
          </div>
        </div>
        <StatusBadge status={job.status} />
      </div>

      {/* Preview */}
      <div className="flex aspect-[9/16] max-h-56 items-center justify-center overflow-hidden rounded-md bg-ink">
        {job.status === "done" && fileUrl ? (
          job.type === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={fileUrl}
              alt={job.label}
              className="h-full w-full object-contain"
            />
          ) : (
            <video
              src={fileUrl}
              controls
              className="h-full w-full object-contain"
            />
          )
        ) : job.status === "generating" ? (
          <span className="text-xs text-amber-300">generando…</span>
        ) : job.status === "failed" ? (
          <span className="px-2 text-center text-xs text-red-300">error</span>
        ) : (
          <span className="text-xs text-slate-600">sin preview</span>
        )}
      </div>

      {job.error && (
        <p className="line-clamp-3 rounded bg-red-500/10 p-1.5 text-[11px] text-red-300">
          {job.error}
        </p>
      )}

      <button
        onClick={() => onRetry(job.id)}
        disabled={job.status === "generating"}
        className="rounded-md border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-40"
      >
        {job.type === "image" ? "Regenerar imagen" : "Regenerar clip"}
      </button>
    </div>
  );
}
