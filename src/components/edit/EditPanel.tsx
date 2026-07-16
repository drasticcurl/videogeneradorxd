"use client";
/**
 * EditPanel — "Enviar al editor" panel for the Resultado page.
 *
 * Provides:
 * - Source selection (clips default / final)
 * - Option toggles (silence-cut, subtitles, music upload)
 * - B-roll browse/select with ordering
 * - Launch button calling POST /api/edit/start
 *
 * Requirements: 1, 2, 3, 4
 */
import { useState, useCallback, useEffect } from "react";
import type { EditOptions } from "@/lib/edit/types";
import {
  apiErrorMessage,
  appendProgressLog,
  controlForStatus,
  encodeMusicFile,
  formatProgressLogLine,
  MUSIC_FILE_ACCEPT,
  parseProgressResponse,
  type ProgressLogEntry,
} from "./editUiData";
import { SilenceTimeline } from "./SilenceTimeline";
import { SubtitleReview } from "./SubtitleReview";
import { FinalRenderTrigger } from "./FinalRenderTrigger";

interface EditPanelProps {
  projectId: string;
  /** Available clip IDs from the manifest */
  clipIds: string[];
  /** Whether the stitched final.mp4 is available */
  hasFinal: boolean;
}

type SourceType = "clips" | "final";

export function EditPanel({ projectId, clipIds, hasFinal }: EditPanelProps) {
  const [source, setSource] = useState<SourceType>("clips");
  const [silenceCut, setSilenceCut] = useState(true);
  const [subtitles, setSubtitles] = useState(true);
  const [musicFile, setMusicFile] = useState<File | null>(null);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editJobId, setEditJobId] = useState<string | null>(null);

  const handleLaunch = useCallback(async () => {
    setLaunching(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        projectId,
        source: source === "final" ? { type: "final" } : { type: "clips", clipIds },
        options: {
          silenceCut,
          subtitles,
          ...(source === "clips"
            ? { ordering: clipIds.map((id, i) => ({ index: i, clipId: id, isBroll: false })) }
            : {}),
        } satisfies EditOptions,
      };

      // The route accepts music bytes as a structured base64 payload.
      if (musicFile) {
        body.music = await encodeMusicFile(musicFile);
      }

      const res = await fetch("/api/edit/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        let data: unknown = text;
        try {
          data = JSON.parse(text);
        } catch {
          // Keep plain-text API errors as-is.
        }
        throw new Error(apiErrorMessage(data, res.status));
      }

      const data = await res.json();
      setEditJobId(data.editJobId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error desconocido");
    } finally {
      setLaunching(false);
    }
  }, [projectId, source, clipIds, silenceCut, subtitles, musicFile]);

  if (editJobId) {
    return <EditProgress editJobId={editJobId} />;
  }

  return (
    <div className="rounded-lg border border-indigo-600/40 bg-panel p-4 space-y-4">
      <h3 className="text-sm font-semibold text-indigo-300 uppercase tracking-wide">
        Enviar al editor
      </h3>

      {/* Source selection */}
      <div className="space-y-2">
        <label className="text-xs text-slate-400 font-medium">Fuente</label>
        <div className="flex gap-3">
          <button
            onClick={() => setSource("clips")}
            className={`rounded-md px-3 py-1.5 text-xs border ${
              source === "clips"
                ? "border-indigo-500 bg-indigo-500/20 text-indigo-200"
                : "border-slate-600 text-slate-400 hover:bg-slate-800"
            }`}
          >
            Clips individuales ({clipIds.length})
          </button>
          {hasFinal && (
            <button
              onClick={() => setSource("final")}
              className={`rounded-md px-3 py-1.5 text-xs border ${
                source === "final"
                  ? "border-indigo-500 bg-indigo-500/20 text-indigo-200"
                  : "border-slate-600 text-slate-400 hover:bg-slate-800"
              }`}
            >
              Video final (final.mp4)
            </button>
          )}
        </div>
      </div>

      {/* Options */}
      <div className="space-y-2">
        <label className="text-xs text-slate-400 font-medium">Opciones</label>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={silenceCut}
              onChange={(e) => setSilenceCut(e.target.checked)}
              className="rounded"
            />
            Cortar silencios
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={subtitles}
              onChange={(e) => setSubtitles(e.target.checked)}
              className="rounded"
            />
            Subtítulos
          </label>
        </div>
      </div>

      {/* Music upload */}
      <div className="space-y-2">
        <label className="text-xs text-slate-400 font-medium">Música (opcional)</label>
        <input
          type="file"
          accept={MUSIC_FILE_ACCEPT}
          onChange={(e) => setMusicFile(e.target.files?.[0] || null)}
          className="text-xs text-slate-400"
        />
        {musicFile && (
          <span className="text-xs text-slate-500">{musicFile.name}</span>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-md bg-red-500/10 border border-red-600/40 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {/* Launch */}
      <button
        onClick={handleLaunch}
        disabled={launching || clipIds.length === 0}
        className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
      >
        {launching ? "Enviando..." : "Enviar al editor"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EditProgress — shows progress + preview + output
// ---------------------------------------------------------------------------

interface EditProgressProps {
  editJobId: string;
}

function EditProgress({ editJobId }: EditProgressProps) {
  const [progress, setProgress] = useState<{
    porcentaje: number;
    pasoActual: string;
    mensaje: string;
    status: string;
    error: { paso: string; motivo: string } | null;
  }>({ porcentaje: 0, pasoActual: "", mensaje: "Iniciando...", status: "queued", error: null });
  // Incrementing this key re-arms the poll loop after a 202 confirmation.
  const [pollKey, setPollKey] = useState(0);
  // Visible play-by-play log accumulated across progress polls.
  const [log, setLog] = useState<ProgressLogEntry[]>([]);
  // Whether the last poll reported live progress (endpoint returns `live`).
  const [live, setLive] = useState(true);

  const restartPoll = useCallback(() => {
    // Optimistically reflect the resumed state and re-arm polling.
    setProgress((prev) => ({ ...prev, status: "running" }));
    setPollKey((k) => k + 1);
  }, []);

  // Poll progress every 2 seconds. Stops only on completed|failed; while the
  // job is in an awaiting_* status the matching control mounts and takes over.
  useEffect(() => {
    let active = true;
    const poll = async () => {
      while (active) {
        try {
          const res = await fetch(`/api/edit/${editJobId}/progress`);
          if (res.ok) {
            const data = await res.json();
            const parsed = parseProgressResponse(data);
            if (!active) return;
            setProgress(parsed);
            setLive(typeof data?.live === "boolean" ? data.live : true);
            // Append a log line only when the observed state actually changed.
            const entry: ProgressLogEntry = {
              time: new Date().toTimeString().slice(0, 8),
              porcentaje: parsed.porcentaje,
              pasoActual: parsed.pasoActual,
              mensaje: parsed.mensaje,
              status: parsed.status,
            };
            setLog((prev) => appendProgressLog(prev, entry));
            if (parsed.status === "completed" || parsed.status === "failed") {
              active = false;
              return;
            }
          }
        } catch {
          // Ignore poll errors
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    };
    poll();
    return () => {
      active = false;
    };
  }, [editJobId, pollKey]);

  const control = controlForStatus(progress.status);

  // Scrollable play-by-play log, shown while the job runs / awaits input.
  const logPanel =
    log.length > 0 ? (
      <div className="space-y-1">
        <div className="flex justify-between text-[11px] text-slate-500">
          <span>Registro del pipeline</span>
          {!live && (
            <span className="text-amber-400/80">· live progress unavailable</span>
          )}
        </div>
        <div className="h-40 overflow-y-auto rounded-md border border-slate-700 bg-slate-900/60 p-2 font-mono text-[11px] leading-relaxed text-slate-300">
          {log.map((e, i) => (
            <div key={i} className="whitespace-pre-wrap break-words">
              {formatProgressLogLine(e)}
            </div>
          ))}
        </div>
      </div>
    ) : null;

  // Awaiting statuses mount the corresponding interactive control. The log
  // panel is rendered alongside so the play-by-play stays visible.
  if (control === "silence") {
    return (
      <div className="space-y-4">
        <SilenceTimeline editJobId={editJobId} onResumed={restartPoll} />
        {logPanel}
      </div>
    );
  }
  if (control === "subtitle") {
    return (
      <div className="space-y-4">
        <SubtitleReview editJobId={editJobId} onResumed={restartPoll} />
        {logPanel}
      </div>
    );
  }
  if (control === "final") {
    return (
      <div className="space-y-4">
        <FinalRenderTrigger editJobId={editJobId} onResumed={restartPoll} />
        {logPanel}
      </div>
    );
  }

  const isComplete = control === "download";
  const isFailed = control === "error";

  return (
    <div className="rounded-lg border border-indigo-600/40 bg-panel p-4 space-y-4">
      <h3 className="text-sm font-semibold text-indigo-300 uppercase tracking-wide">
        Progreso de edición
      </h3>

      {isComplete ? (
        <div className="space-y-2">
          <div className="text-xs text-emerald-300 font-medium">Edición completada</div>
          <a
            href={`/api/edit/${editJobId}/result`}
            className="inline-block rounded-md bg-emerald-600 px-3 py-1.5 text-xs text-white hover:bg-emerald-500"
          >
            Descargar resultado
          </a>
        </div>
      ) : isFailed ? (
        <div className="rounded-md bg-red-500/10 border border-red-600/40 px-3 py-2 text-xs text-red-300 space-y-1">
          {progress.error ? (
            <>
              <div className="font-semibold">Error en el paso: {progress.error.paso}</div>
              <div className="text-slate-400">Motivo:</div>
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-red-200">
                {progress.error.motivo}
              </pre>
            </>
          ) : (
            <div className="whitespace-pre-wrap break-words">Error: {progress.mensaje}</div>
          )}
        </div>
      ) : (
        // queued | uploading | running → live progress bar
        <div className="space-y-3">
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-slate-400">
              <span>{progress.pasoActual || progress.mensaje}</span>
              <span>{progress.porcentaje}%</span>
            </div>
            <div className="h-2 rounded-full bg-slate-700 overflow-hidden">
              <div
                className="h-full rounded-full bg-indigo-500 transition-all"
                style={{ width: `${progress.porcentaje}%` }}
              />
            </div>
          </div>
          {logPanel}
        </div>
      )}
    </div>
  );
}
