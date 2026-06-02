"use client";
/**
 * Pantalla "Nuevo proyecto":
 *  - Selectores de modelo (Chat/Imagen/Video) + variantes.
 *  - Dos formas de armar el plan:
 *      a) "Interpretar con IA": pegás el brief y la IA arma el PlanJSON.
 *      b) "Pegar PlanJSON": pegás el JSON ya armado (lo generaste con el prompt copiable).
 *  - PlanJSON editable + estimacion + "Generar todo".
 *  - Lista de proyectos existentes.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useProjectStore } from "@/store/useProjectStore";
import { JsonEditor } from "@/components/JsonEditor";
import { CostEstimatePanel } from "@/components/CostEstimatePanel";
import { StatusBadge } from "@/components/StatusBadge";
import { ModelSelectorBar } from "@/components/ModelSelectorBar";
import { SAMPLE_BRIEF } from "@/lib/sampleBrief";
import { STORYBOARD_PROMPT_TEMPLATE } from "@/lib/prompts";

interface ProjectSummary {
  id: string;
  name: string;
  status: "draft" | "running" | "review" | "done" | "failed" | "partial" | "paused";
  createdAt: string;
  clipCount: number;
  imageCount: number;
}

type Mode = "ia" | "json";

export default function HomePage() {
  const router = useRouter();
  const {
    brief,
    plan,
    estimate,
    parsing,
    error,
    selectedModels,
    imageVariants,
    defaultResolution,
    references,
    setBrief,
    loadConfig,
    parseBrief,
    setPlan,
    setPlanFromJson,
    addReferenceFile,
    updateReference,
    removeReference,
    uploadReferences,
    reset,
  } = useProjectStore();

  const [name, setName] = useState("");
  const [mode, setMode] = useState<Mode>("ia");
  const [jsonText, setJsonText] = useState("");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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

  function applyPastedJson() {
    setPlanFromJson(jsonText);
  }

  async function handleGenerateAll() {
    if (!plan) return;
    setCreating(true);
    setCreateError(null);
    try {
      const createRes = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          brief,
          plan,
          models: selectedModels,
          imageVariants,
          defaultResolution,
        }),
      });
      const createData = await createRes.json();
      if (!createRes.ok) throw new Error(createData.error ?? "No se pudo crear el proyecto");
      const projectId = createData.project.id as string;

      // Subimos las fotos/avatares de referencia (VSL) antes de generar, asi el
      // pipeline puede usarlas como fuente de identidad de cada plano.
      if (references.length > 0) {
        await uploadReferences(projectId);
      }

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

  function copyPromptTemplate() {
    navigator.clipboard?.writeText(STORYBOARD_PROMPT_TEMPLATE);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="space-y-6">
      <ModelSelectorBar />

      <section className="space-y-4">
        <h1 className="text-2xl font-bold">Nuevo proyecto</h1>

        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nombre del proyecto (opcional)"
          className="w-full rounded-lg border border-slate-700 bg-ink px-3 py-2 text-sm focus:border-accent focus:outline-none"
        />

        {/* Toggle de modo */}
        <div className="flex gap-1 rounded-lg border border-slate-800 bg-panel p-1 text-sm">
          <button
            onClick={() => setMode("ia")}
            className={`rounded-md px-4 py-1.5 ${
              mode === "ia" ? "bg-accent text-white" : "text-slate-300 hover:bg-slate-800"
            }`}
          >
            Interpretar brief con IA
          </button>
          <button
            onClick={() => setMode("json")}
            className={`rounded-md px-4 py-1.5 ${
              mode === "json" ? "bg-accent text-white" : "text-slate-300 hover:bg-slate-800"
            }`}
          >
            Pegar PlanJSON
          </button>
          <button
            onClick={copyPromptTemplate}
            className="ml-auto rounded-md px-3 py-1.5 text-slate-300 hover:bg-slate-800"
            title="Copiá este prompt, pegalo en ChatGPT/Gemini con tu brief, y te devuelve el JSON exacto"
          >
            {copied ? "✓ prompt copiado" : "📋 Copiar prompt para tu IA"}
          </button>
        </div>

        {mode === "ia" ? (
          <>
            {/* Avatares de referencia (VSL): subís las fotos de las personas y la IA
                genera todos los planos manteniendo esa misma cara. */}
            <div className="space-y-3 rounded-lg border border-slate-800 bg-panel p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-slate-100">
                    Avatares de referencia <span className="text-slate-500">(VSL · opcional)</span>
                  </h3>
                  <p className="text-xs text-slate-500">
                    Subí las fotos de las personas (ej. 2). La IA va a generar todos los planos
                    manteniendo <b>la misma cara</b> en cada uno (image2image).
                  </p>
                </div>
                <label className="cursor-pointer rounded-lg border border-slate-600 px-3 py-2 text-sm hover:bg-slate-800">
                  + Agregar foto
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    multiple
                    className="hidden"
                    onChange={async (e) => {
                      const files = Array.from(e.target.files ?? []);
                      for (const f of files) await addReferenceFile(f);
                      e.target.value = "";
                    }}
                  />
                </label>
              </div>

              {references.length > 0 && (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {references.map((r) => (
                    <div
                      key={r.id}
                      className="flex flex-col gap-2 rounded-lg border border-slate-700 bg-ink p-2"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={r.dataUrl}
                        alt={r.label || r.id}
                        className="aspect-[3/4] w-full rounded object-cover"
                      />
                      <input
                        value={r.label}
                        onChange={(e) => updateReference(r.id, { label: e.target.value })}
                        placeholder="Nombre (ej. Natalia)"
                        className="rounded border border-slate-700 bg-panel px-2 py-1 text-xs focus:border-accent focus:outline-none"
                      />
                      <div className="flex items-center justify-between gap-1">
                        <code className="truncate text-[10px] text-slate-500" title={r.id}>
                          id: {r.id}
                        </code>
                        <button
                          onClick={() => removeReference(r.id)}
                          className="rounded px-1.5 py-0.5 text-[11px] text-red-300 hover:bg-red-500/10"
                          title="Quitar"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {references.length > 0 && (
                <p className="text-[11px] text-slate-500">
                  En el brief mencioná a cada persona por su nombre. La IA va a crear un avatar por
                  cada foto y usar esa identidad en todos sus clips. El <code>id</code> es el que la IA
                  usa internamente para referenciar la foto.
                </p>
              )}
            </div>

            <textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="Pegá acá tu brief largo con avatares, b-roll y clips en orden…"
              className="h-56 w-full resize-y rounded-lg border border-slate-700 bg-ink p-3 text-sm leading-relaxed focus:border-accent focus:outline-none"
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
          </>
        ) : (
          <>
            <textarea
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              placeholder='Pegá acá el PlanJSON (el que te devolvió tu IA usando el prompt copiable)…'
              spellCheck={false}
              className="code h-56 w-full resize-y rounded-lg border border-slate-700 bg-ink p-3 text-xs leading-relaxed focus:border-accent focus:outline-none"
            />
            <button
              onClick={applyPastedJson}
              disabled={!jsonText.trim()}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Cargar PlanJSON
            </button>
          </>
        )}

        {error && (
          <p className="rounded bg-red-500/10 p-2 text-sm text-red-300">{error}</p>
        )}
      </section>

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
                Cada imagen y cada video van a pedirte <b>aprobación</b> antes de seguir.
                Todo se guarda en <code className="text-slate-300">output/&lt;project_id&gt;/</code>.
              </p>
            </div>
          </div>
        </section>
      )}

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
