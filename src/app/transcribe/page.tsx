"use client";
/**
 * Pantalla "Transcribir":
 *  - Subís uno o varios clips (video o audio).
 *  - Cada uno se transcribe LOCALMENTE con Whisper (modelo `small`, español, sin API).
 *  - Se procesan de a uno (en cola) para no saturar la CPU.
 *  - El texto queda editable + copiable (objetivo: pasarlo despues a otras IAs para analisis).
 *
 * Nada de esto usa Vertex/credenciales: pega los archivos a POST /api/transcribe, que
 * corre `whisper` por detras y devuelve el texto.
 */
import { useEffect, useRef, useState } from "react";

type ItemStatus = "pendiente" | "transcribiendo" | "listo" | "error";

interface TranscribeItem {
  uid: string;
  file: File;
  status: ItemStatus;
  text: string;
  error: string | null;
  durationMs: number | null;
}

interface WhisperConfig {
  available: boolean;
  bin: string;
  model: string;
  language: string;
}

let uidSeq = 0;
const nextUid = () => `t${Date.now()}_${uidSeq++}`;

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

const STATUS_STYLES: Record<ItemStatus, string> = {
  pendiente: "bg-slate-600/30 text-slate-300",
  transcribiendo: "bg-amber-500/20 text-amber-300",
  listo: "bg-emerald-500/20 text-emerald-300",
  error: "bg-red-500/20 text-red-300",
};

export default function TranscribePage() {
  const [items, setItems] = useState<TranscribeItem[]>([]);
  const [running, setRunning] = useState(false);
  const [whisper, setWhisper] = useState<WhisperConfig | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/config");
        const data = await res.json();
        if (data.whisper) setWhisper(data.whisper as WhisperConfig);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  function addFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    setItems((prev) => [
      ...prev,
      ...list.map((file) => ({
        uid: nextUid(),
        file,
        status: "pendiente" as ItemStatus,
        text: "",
        error: null,
        durationMs: null,
      })),
    ]);
  }

  function patch(uid: string, partial: Partial<TranscribeItem>) {
    setItems((prev) =>
      prev.map((it) => (it.uid === uid ? { ...it, ...partial } : it))
    );
  }

  function removeItem(uid: string) {
    setItems((prev) => prev.filter((it) => it.uid !== uid));
  }

  function clearDone() {
    setItems((prev) => prev.filter((it) => it.status !== "listo"));
  }

  /** Transcribe UN item (espera la respuesta del backend). */
  async function transcribeOne(item: TranscribeItem): Promise<void> {
    patch(item.uid, { status: "transcribiendo", error: null });
    try {
      const form = new FormData();
      form.append("file", item.file);
      const res = await fetch("/api/transcribe", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "No se pudo transcribir.");
      patch(item.uid, {
        status: "listo",
        text: data.text ?? "",
        durationMs: typeof data.durationMs === "number" ? data.durationMs : null,
      });
    } catch (err) {
      patch(item.uid, {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Procesa en cola (de a uno) todos los pendientes / con error. */
  async function transcribeAll() {
    if (running) return;
    setRunning(true);
    try {
      // Tomamos una foto del estado actual y recorremos los que faltan.
      const pending = items.filter(
        (it) => it.status === "pendiente" || it.status === "error"
      );
      for (const it of pending) {
        await transcribeOne(it);
      }
    } finally {
      setRunning(false);
    }
  }

  function copyText(text: string) {
    navigator.clipboard?.writeText(text);
  }

  function allText(): string {
    return items
      .filter((it) => it.status === "listo" && it.text.trim())
      .map((it) => `### ${it.file.name}\n${it.text.trim()}`)
      .join("\n\n");
  }

  function copyAll() {
    const text = allText();
    if (!text) return;
    navigator.clipboard?.writeText(text);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 1800);
  }

  function downloadAll() {
    const text = allText();
    if (!text) return;
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "transcripciones.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  const pendingCount = items.filter(
    (it) => it.status === "pendiente" || it.status === "error"
  ).length;
  const doneCount = items.filter((it) => it.status === "listo").length;

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h1 className="text-2xl font-bold">Transcribir clips</h1>
        <p className="text-sm text-slate-400">
          Subí tus clips (video o audio) y se transcriben a <b>texto en español</b> con
          Whisper corriendo <b>local</b> (modelo{" "}
          <code className="text-slate-200">{whisper?.model ?? "small"}</code>), sin API ni
          costos. Despues podés copiar el texto y pasarlo a otras IAs para el análisis.
        </p>
      </section>

      {/* Estado de Whisper */}
      {whisper && !whisper.available && (
        <div className="space-y-2 rounded-lg border border-amber-700/60 bg-amber-500/10 p-4 text-sm text-amber-200">
          <p className="font-semibold">
            ⚠ No se detectó el comando{" "}
            <code className="text-amber-100">{whisper.bin}</code> en el PATH.
          </p>
          <p className="text-amber-200/90">
            Instalá Whisper local (gratis) y asegurate de tener ffmpeg:
          </p>
          <pre className="code overflow-x-auto rounded bg-ink/70 p-3 text-xs text-amber-100">
            pip install -U openai-whisper{"\n"}# ffmpeg: choco install ffmpeg (Win) · brew
            install ffmpeg (Mac) · apt install ffmpeg (Linux)
          </pre>
          <p className="text-xs text-amber-200/70">
            Si tu binario tiene otro nombre/ruta, configurá{" "}
            <code>WHISPER_BIN</code> en <code>.env.local</code> y reiniciá el server.
            (Igual podés intentar transcribir; si falla, vas a ver el error abajo.)
          </p>
        </div>
      )}

      {whisper && whisper.available && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-panel px-4 py-2 text-xs text-slate-400">
          <span className="inline-flex items-center gap-1 text-emerald-300">
            ● Whisper detectado
          </span>
          <span className="text-slate-600">·</span>
          <span>
            modelo <code className="text-slate-200">{whisper.model}</code>
          </span>
          <span className="text-slate-600">·</span>
          <span>
            idioma <code className="text-slate-200">{whisper.language}</code>
          </span>
        </div>
      )}

      {/* Drop zone / file input */}
      <section
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
        }}
        className="rounded-xl border-2 border-dashed border-slate-700 bg-panel/40 p-8 text-center"
      >
        <p className="text-sm text-slate-300">
          Arrastrá tus clips acá, o
        </p>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90"
        >
          + Elegir archivos
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*,audio/*,.mp4,.mov,.mkv,.webm,.mp3,.wav,.m4a,.aac,.ogg,.flac"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <p className="mt-3 text-xs text-slate-500">
          Acepta video y audio (mp4, mov, mkv, webm, mp3, wav, m4a…). Se procesan de a uno.
        </p>
      </section>

      {/* Acciones globales */}
      {items.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => void transcribeAll()}
            disabled={running || pendingCount === 0}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {running
              ? "Transcribiendo…"
              : `Transcribir ${pendingCount > 0 ? `(${pendingCount})` : ""}`}
          </button>
          <button
            onClick={copyAll}
            disabled={doneCount === 0}
            className="rounded-lg border border-slate-600 px-4 py-2 text-sm hover:bg-slate-800 disabled:opacity-40"
          >
            {copiedAll ? "✓ copiado" : "📋 Copiar todo"}
          </button>
          <button
            onClick={downloadAll}
            disabled={doneCount === 0}
            className="rounded-lg border border-slate-600 px-4 py-2 text-sm hover:bg-slate-800 disabled:opacity-40"
          >
            ⬇ Descargar .txt
          </button>
          {doneCount > 0 && (
            <button
              onClick={clearDone}
              className="ml-auto rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-slate-800"
            >
              Limpiar terminados
            </button>
          )}
        </div>
      )}

      {/* Lista de items */}
      <section className="space-y-3">
        {items.map((it) => (
          <div
            key={it.uid}
            className="space-y-3 rounded-lg border border-slate-800 bg-panel p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-slate-100">{it.file.name}</span>
              <span className="text-xs text-slate-500">{fmtSize(it.file.size)}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[it.status]}`}
              >
                {it.status === "transcribiendo" ? "transcribiendo…" : it.status}
              </span>
              {it.durationMs != null && (
                <span className="text-[11px] text-slate-500">
                  · {fmtDuration(it.durationMs)}
                </span>
              )}
              <div className="ml-auto flex items-center gap-2">
                {(it.status === "pendiente" || it.status === "error") && (
                  <button
                    onClick={() => void transcribeOne(it)}
                    disabled={running}
                    className="rounded border border-slate-600 px-2 py-1 text-xs hover:bg-slate-800 disabled:opacity-40"
                  >
                    Transcribir
                  </button>
                )}
                <button
                  onClick={() => removeItem(it.uid)}
                  className="rounded px-2 py-1 text-xs text-red-300 hover:bg-red-500/10"
                  title="Quitar"
                >
                  ✕
                </button>
              </div>
            </div>

            {it.status === "error" && it.error && (
              <pre className="code overflow-x-auto whitespace-pre-wrap rounded bg-red-500/10 p-3 text-xs text-red-200">
                {it.error}
              </pre>
            )}

            {(it.status === "listo" || it.text) && (
              <div className="space-y-2">
                <textarea
                  value={it.text}
                  onChange={(e) => patch(it.uid, { text: e.target.value })}
                  spellCheck={false}
                  className="h-40 w-full resize-y rounded-lg border border-slate-700 bg-ink p-3 text-sm leading-relaxed focus:border-accent focus:outline-none"
                  placeholder="(transcripción)"
                />
                <button
                  onClick={() => copyText(it.text)}
                  className="rounded border border-slate-600 px-3 py-1 text-xs hover:bg-slate-800"
                >
                  📋 Copiar
                </button>
              </div>
            )}
          </div>
        ))}
      </section>

      {items.length === 0 && (
        <p className="text-center text-sm text-slate-500">
          Todavía no agregaste clips. Subí uno arriba para empezar.
        </p>
      )}
    </div>
  );
}
