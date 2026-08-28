"use client";

/**
 * Tablero de solo imagenes: se pegan prompts, se generan con N variantes, se elige
 * la que queda y se puede variar cualquiera sin tocar las demas.
 *
 * Reusa el pipeline normal: crea un proyecto con `clips: []` (ver
 * /api/imagenes/route.ts) y despues habla con las MISMAS rutas que el flujo de brief
 * (`/jobs` para el polling, `/jobs/:id/approve` para elegir variante,
 * `/jobs/:id/prompt` para regenerar). No hay lógica de generación duplicada acá.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { ModelOption } from "@/lib/config";

interface Candidate {
  index: number;
  file: string;
}

interface Job {
  id: string;
  refId: string;
  label: string;
  status: string;
  type: string;
  error: string | null;
  outputPath: string | null;
  candidates: Candidate[];
  selectedIndex: number | null;
  variants: number;
  attempts: number;
}

interface ManifestImage {
  id: string;
  prompt: string;
}

const EN_CURSO = new Set(["pending", "queued", "generating", "waiting"]);

export default function ImagenesBoard({
  modelos,
  modeloDefault,
}: {
  modelos: ModelOption[];
  modeloDefault: string;
}) {
  const [nombre, setNombre] = useState("");
  const [texto, setTexto] = useState("");
  const [variantes, setVariantes] = useState(2);
  const [modelo, setModelo] = useState(modeloDefault);
  const [negativo, setNegativo] = useState("");

  const [projectId, setProjectId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  // Prompts en edicion, por refId. Separado de `prompts` para no perder lo tipeado
  // cuando llega una respuesta del polling.
  const [editando, setEditando] = useState<Record<string, string>>({});
  const [ocupado, setOcupado] = useState<Record<string, boolean>>({});

  // Cantidad de prompts en vivo, para mostrar el costo antes de apretar.
  const cantidadPrompts = texto
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean).length;

  // ─── Polling ──────────────────────────────────────────────────────────────
  // Se guarda en un ref para poder pararlo desde el efecto sin re-crearlo en cada
  // render (si no, cada cambio de estado reinicia el intervalo y el polling se
  // dispara mucho mas seguido de lo que dice el numero).
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const traerEstado = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/projects/${id}/jobs`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as {
        jobs?: Job[];
        manifest?: { images?: ManifestImage[] };
      };
      setJobs((data.jobs ?? []).filter((j) => j.type === "image"));
      const mapa: Record<string, string> = {};
      for (const img of data.manifest?.images ?? []) mapa[img.id] = img.prompt;
      setPrompts(mapa);
    } catch {
      // Un fallo de red puntual no tiene que romper la pantalla: el proximo tick
      // reintenta solo.
    }
  }, []);

  useEffect(() => {
    if (!projectId) return;
    void traerEstado(projectId);
    pollRef.current = setInterval(() => void traerEstado(projectId), 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [projectId, traerEstado]);

  // Cuando no queda nada en curso, se corta el polling: esta pantalla puede quedar
  // abierta horas y no tiene sentido pegarle a la API cada 3s sin nada que mirar.
  const hayEnCurso = jobs.some((j) => EN_CURSO.has(j.status));
  useEffect(() => {
    if (!hayEnCurso && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, [hayEnCurso]);

  // ─── Acciones ─────────────────────────────────────────────────────────────

  async function generar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setEnviando(true);
    try {
      const res = await fetch("/api/imagenes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nombre,
          prompts: texto,
          variantes,
          model: modelo,
          negativePrompt: negativo,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        project?: { id: string };
        error?: string;
        detail?: unknown;
      };
      if (!res.ok || !data.project) {
        setError(data.error ?? `Error ${res.status}`);
        return;
      }
      setProjectId(data.project.id);
      setJobs([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error de red");
    } finally {
      setEnviando(false);
    }
  }

  /** Elegir cual de las variantes queda como la imagen definitiva. */
  async function elegir(job: Job, index: number) {
    setOcupado((o) => ({ ...o, [job.id]: true }));
    try {
      await fetch(`/api/jobs/${job.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index }),
      });
      if (projectId) await traerEstado(projectId);
    } finally {
      setOcupado((o) => ({ ...o, [job.id]: false }));
    }
  }

  /**
   * Variar: regenera las variantes de UNA imagen, con el prompt editado si se toco.
   * Es la ruta que ya usa el flujo de brief, asi que el cambio queda persistido en el
   * plan del proyecto y no solo en la pantalla.
   */
  async function variar(job: Job) {
    setOcupado((o) => ({ ...o, [job.id]: true }));
    try {
      const nuevo = editando[job.refId];
      await fetch(`/api/jobs/${job.id}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: (nuevo ?? prompts[job.refId] ?? "").trim() || undefined,
          regenerate: true,
        }),
      });
      setEditando((ed) => {
        const { [job.refId]: _, ...resto } = ed;
        return resto;
      });
      if (projectId) {
        await traerEstado(projectId);
        // El job vuelve a "generating": se relanza el polling si estaba parado.
        if (!pollRef.current) {
          pollRef.current = setInterval(() => void traerEstado(projectId), 3000);
        }
      }
    } finally {
      setOcupado((o) => ({ ...o, [job.id]: false }));
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  const listas = jobs.filter((j) => j.status === "done").length;

  return (
    <div className="space-y-6">
      <form
        onSubmit={generar}
        className="rounded-xl border border-slate-800 bg-panel/60 p-5"
      >
        <h2 className="text-base font-semibold">Generar imágenes</h2>
        <p className="mt-1 text-sm text-slate-400">
          Un prompt por línea. Los archivos se nombran con el nombre del proyecto.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="nombre" className="block text-sm font-medium text-slate-300">
              Nombre del proyecto
            </label>
            <input
              id="nombre"
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              required
              placeholder="crema manos"
              className="mt-1 w-full rounded-md border border-slate-700 bg-ink px-3 py-2 text-sm text-slate-100 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <p className="mt-1 text-xs text-slate-500">
              Los archivos van a salir como{" "}
              <code className="text-slate-400">
                {(nombre.trim() || "nombre")
                  .toLowerCase()
                  .normalize("NFD")
                  .replace(/[\u0300-\u036f]/g, "")
                  .replace(/[^a-z0-9]+/g, "_")
                  .replace(/^_+|_+$/g, "") || "nombre"}
                _01.png
              </code>
            </p>
          </div>

          <div>
            <label htmlFor="modelo" className="block text-sm font-medium text-slate-300">
              Modelo
            </label>
            <select
              id="modelo"
              value={modelo}
              onChange={(e) => setModelo(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-700 bg-ink px-3 py-2 text-sm text-slate-100 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            >
              {modelos.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>

            <label
              htmlFor="variantes"
              className="mt-3 block text-sm font-medium text-slate-300"
            >
              Variantes por prompt
            </label>
            <select
              id="variantes"
              value={variantes}
              onChange={(e) => setVariantes(Number(e.target.value))}
              className="mt-1 w-full rounded-md border border-slate-700 bg-ink px-3 py-2 text-sm text-slate-100 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            >
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-4">
          <label htmlFor="prompts" className="block text-sm font-medium text-slate-300">
            Prompts (uno por línea)
          </label>
          <textarea
            id="prompts"
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            required
            rows={8}
            placeholder={
              "A woman applying hand cream, close up on dry hands, natural window light\nSame woman smiling, showing soft hydrated hands, warm kitchen background"
            }
            className="code mt-1 w-full rounded-md border border-slate-700 bg-ink px-3 py-2 text-sm text-slate-100 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>

        <div className="mt-4">
          <label htmlFor="negativo" className="block text-sm font-medium text-slate-300">
            Negative prompt (opcional, aplica a todas)
          </label>
          <input
            id="negativo"
            value={negativo}
            onChange={(e) => setNegativo(e.target.value)}
            placeholder="text, watermark, extra fingers"
            className="mt-1 w-full rounded-md border border-slate-700 bg-ink px-3 py-2 text-sm text-slate-100 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>

        <div aria-live="polite">
          {error && (
            <p
              role="alert"
              className="mt-4 rounded-md border border-red-800 bg-red-950/40 px-3 py-2 text-sm text-red-200"
            >
              {error}
            </p>
          )}
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            type="submit"
            disabled={enviando || cantidadPrompts === 0 || nombre.trim().length === 0}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {enviando ? "Creando…" : "Generar"}
          </button>
          {cantidadPrompts > 0 && (
            <span className="text-sm text-slate-400">
              {cantidadPrompts} prompt{cantidadPrompts === 1 ? "" : "s"} ×{" "}
              {variantes} = <strong>{cantidadPrompts * variantes}</strong> imágenes
            </span>
          )}
        </div>
      </form>

      {projectId && (
        <section className="rounded-xl border border-slate-800 bg-panel/60 p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold">
              Resultados{" "}
              <span className="text-sm font-normal text-slate-400">
                {listas}/{jobs.length} listas
              </span>
            </h2>
            <a
              href={`/api/projects/${projectId}/download`}
              className="text-sm text-accent hover:text-indigo-400"
            >
              Descargar todo (zip)
            </a>
          </div>

          {jobs.length === 0 && (
            <p className="mt-4 text-sm text-slate-400">Encolando…</p>
          )}

          <div className="mt-4 space-y-5">
            {jobs.map((job) => {
              const prompt = prompts[job.refId] ?? "";
              const enEdicion = editando[job.refId];
              const trabajando = ocupado[job.id] || EN_CURSO.has(job.status);
              return (
                <article
                  key={job.id}
                  className="rounded-lg border border-slate-800 bg-ink/40 p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-mono text-sm text-slate-300">{job.refId}</h3>
                    <span
                      className={`rounded px-2 py-0.5 text-xs ${
                        job.status === "done"
                          ? "bg-emerald-950 text-emerald-300"
                          : job.status === "failed"
                            ? "bg-red-950 text-red-300"
                            : "bg-slate-800 text-slate-300"
                      }`}
                    >
                      {job.status}
                      {job.attempts > 1 ? ` · intento ${job.attempts}` : ""}
                    </span>
                  </div>

                  {job.error && (
                    <p
                      role="alert"
                      className="mt-2 rounded border border-red-900 bg-red-950/30 px-2 py-1 text-xs text-red-200"
                    >
                      {job.error}
                    </p>
                  )}

                  <textarea
                    aria-label={`Prompt de ${job.refId}`}
                    value={enEdicion ?? prompt}
                    onChange={(e) =>
                      setEditando((ed) => ({ ...ed, [job.refId]: e.target.value }))
                    }
                    rows={2}
                    className="code mt-3 w-full rounded-md border border-slate-700 bg-ink px-2 py-1.5 text-xs text-slate-200 focus:border-accent focus:outline-none"
                  />

                  <div className="mt-3 flex flex-wrap gap-3">
                    {job.candidates.map((c) => {
                      const elegida = job.selectedIndex === c.index;
                      return (
                        <div key={c.index} className="w-32">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`/api/files/${projectId}/${c.file}`}
                            alt={`${job.refId} variante ${c.index}`}
                            className={`aspect-[9/16] w-32 rounded-md border-2 object-cover ${
                              elegida ? "border-accent" : "border-slate-700"
                            }`}
                          />
                          <button
                            type="button"
                            onClick={() => void elegir(job, c.index)}
                            disabled={trabajando}
                            className={`mt-1 w-full rounded border px-2 py-1 text-xs transition disabled:opacity-50 ${
                              elegida
                                ? "border-accent bg-accent/20 text-white"
                                : "border-slate-700 text-slate-300 hover:border-slate-500"
                            }`}
                          >
                            {elegida ? `✓ v${c.index}` : `Elegir v${c.index}`}
                          </button>
                        </div>
                      );
                    })}

                    {job.candidates.length === 0 && (
                      <p className="text-sm text-slate-500">
                        {EN_CURSO.has(job.status) ? "Generando…" : "Sin variantes."}
                      </p>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => void variar(job)}
                    disabled={trabajando}
                    className="mt-3 rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-200 transition hover:border-slate-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {trabajando
                      ? "Generando…"
                      : enEdicion !== undefined
                        ? "Variar con el prompt editado"
                        : "Variar"}
                  </button>
                </article>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
