"use client";
/**
 * Pantalla "Nuevo proyecto":
 *  - textarea del brief + "Interpretar con IA" -> muestra PlanJSON editable + estimacion.
 *  - "Generar todo": crea el proyecto, dispara el pipeline y navega a /project/:id/pipeline.
 *  - Lista de proyectos existentes para reabrir.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useProjectStore } from "@/store/useProjectStore";
import { JsonEditor } from "@/components/JsonEditor";
import { CostEstimatePanel } from "@/components/CostEstimatePanel";
import { StatusBadge } from "@/components/StatusBadge";
import { SAMPLE_BRIEF } from "@/lib/sampleBrief";

interface ProjectSummary {
  id: string;
  name: string;
  status: "draft" | "running" | "done" | "failed" | "partial";
  createdAt: string;
  clipCount: number;
  imageCount: number;
}

export default function HomePage() {
  const router = useRouter();
  const {
    config,
    brief,
    plan,
    estimate,
    parsing,
    error,
    setBrief,
    loadConfig,
    parseBrief,
    setPlan,
    reset,
  } = useProjectStore();

  const [name, setName] = useState("");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    reset();
    loadConfig();
    void loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadProjects() {
    try {
      const res = await fetch("/api/projects");
      const data = await res.json();
      setProjects(data.projects ?? []);
    } catch {
      /* ignore */
    }
  }

  async function handleGenerateAll() {
    if (!plan) return;
    setCreating(true);
    setCreateError(null);
    try {
      const createRes = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, brief, plan }),
      });
      const createData = await createRes.json();
      if (!createRes.ok) throw new Error(createData.error ?? "No se pudo crear el proyecto");
      const projectId = createData.project.id as string;

      const genRes = await fetch(`/api/projects/${projectId}/generate`, {
        method: "POST",
      });
      const genData = await genRes.json();
      if (!genRes.ok) throw new Error(genData.error ?? "No se pudo iniciar el pipeline");

      router.push(`/project/${projectId}/pipeline`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
      setCreating(false);
    }
  }

  const isVertexMissing =
    config?.providerMode === "vertex" && !config?.project;

  return (
    <div className="space-y-8">
      {/* Banner de configuracion */}
      {config && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-700 bg-panel px-4 py-2 text-xs text-slate-300">
          <span>
            Proveedor: <b className="text-slate-100">{config.providerMode}</b>
          </span>
          <span>·</span>
          <span>LLM: {config.models.llm}</span>
          <span>·</span>
          <span>Imagen: {config.models.image}</span>
          <span>·</span>
          <span>Video: {config.models.video}</span>
          <span>·</span>
          <span>ffmpeg: {config.ffmpeg ? "si" : "no"}</span>
          {isVertexMissing && (
            <span className="ml-auto rounded bg-amber-500/20 px-2 py-0.5 text-amber-300">
              Falta GOOGLE_CLOUD_PROJECT (o usá PROVIDER_MODE=mock)
            </span>
          )}
        </div>
      )}

      <section className="space-y-4">
        <h1 className="text-2xl font-bold">Nuevo proyecto</h1>
        <p className="text-sm text-slate-400">
          Pegá el brief con tus escenas (formato libre, con marcas [visual]/[audio] o prosa). La IA
          lo interpreta y arma el plan; vos lo revisás y editás antes de generar.
        </p>

        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nombre del proyecto (opcional)"
          className="w-full rounded-lg border border-slate-700 bg-ink px-3 py-2 text-sm focus:border-accent focus:outline-none"
        />

        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="Pegá acá tu brief largo con avatares, b-roll y clips en orden…"
          className="h-64 w-full resize-y rounded-lg border border-slate-700 bg-ink p-3 text-sm leading-relaxed focus:border-accent focus:outline-none"
        />

        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => setBrief(SAMPLE_BRIEF)}
            className="rounded-lg border border-slate-600 px-4 py-2 text-sm hover:bg-slate-800"
          >
            Cargar ejemplo
          </button>
          <button
            onClick={() => void parseBrief()}
            disabled={parsing || !brief.trim()}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {parsing ? "Interpretando…" : "Interpretar con IA"}
          </button>
        </div>

        {error && (
          <p className="rounded bg-red-500/10 p-2 text-sm text-red-300">{error}</p>
        )}
      </section>

      {/* Plan editable + estimacion + generar */}
      {plan && (
        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Revisá y editá el plan</h2>
          {plan.warnings?.length > 0 && (
            <ul className="space-y-1 rounded-lg border border-amber-700/50 bg-amber-500/10 p-3 text-xs text-amber-200">
              {plan.warnings.map((w, i) => (
                <li key={i}>⚠ {w}</li>
              ))}
            </ul>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <JsonEditor value={plan} onValidChange={setPlan} />
            <div className="space-y-4">
              {estimate && <CostEstimatePanel estimate={estimate} />}
              <button
                onClick={() => void handleGenerateAll()}
                disabled={creating}
                className="w-full rounded-lg bg-emerald-600 px-4 py-3 text-base font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {creating ? "Creando proyecto…" : "Generar todo ▶"}
              </button>
              {createError && (
                <p className="rounded bg-red-500/10 p-2 text-sm text-red-300">
                  {createError}
                </p>
              )}
              <p className="text-xs text-slate-500">
                Al generar, todo se guarda en{" "}
                <code className="text-slate-300">
                  {config?.outputDir ?? "./output"}/&lt;project_id&gt;/
                </code>
                : imagenes, clips y manifest.json.
              </p>
            </div>
          </div>
        </section>
      )}

      {/* Proyectos existentes */}
      {projects.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Proyectos</h2>
          <div className="divide-y divide-slate-800 rounded-lg border border-slate-800">
            {projects.map((p) => (
              <Link
                key={p.id}
                href={`/project/${p.id}/pipeline`}
                className="flex items-center justify-between px-4 py-3 hover:bg-slate-800/50"
              >
                <div>
                  <div className="font-medium">{p.name}</div>
                  <div className="text-xs text-slate-500">
                    {p.imageCount} imagenes · {p.clipCount} clips ·{" "}
                    {new Date(p.createdAt).toLocaleString()}
                  </div>
                </div>
                <StatusBadge status={p.status} />
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
