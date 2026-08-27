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
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useProjectStore } from "@/store/useProjectStore";
import { validatePlan, type ProjectPlan } from "@/lib/schema";
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

/**
 * Un PlanJSON leido de un archivo al importar una carpeta en lote.
 * Se valida en el cliente (mismo Zod que el backend) ANTES de crear nada, asi
 * ves de una que archivos estan sanos y cuales tienen errores.
 */
interface ImportedPlan {
  fileName: string;
  /** nombre que va a tener el proyecto (editable) */
  name: string;
  plan: ProjectPlan | null;
  errors: string[];
  clipCount: number;
  imageCount: number;
  status: "listo" | "invalido" | "creando" | "creado" | "error";
  projectId?: string;
  createError?: string;
}

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
    autoApprove,
    setAutoApprove,
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
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Importacion en lote (carpeta con varios PlanJSON).
  const [imported, setImported] = useState<ImportedPlan[]>([]);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // `webkitdirectory` no existe en los tipos de React, asi que lo seteamos a mano
  // sobre el input una vez montado (es lo que habilita el selector de CARPETA).
  useEffect(() => {
    const el = folderInputRef.current;
    if (!el) return;
    el.setAttribute("webkitdirectory", "");
    el.setAttribute("directory", "");
  }, [mode]);

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

  /**
   * Borra un proyecto: registro en db.json + jobs + logs + la carpeta
   * output/<id>/ ENTERA (imagenes, clips, referencias, final.mp4).
   * Es irreversible, por eso pide confirmacion mostrando cuantos archivos se pierden.
   */
  async function handleDeleteProject(p: ProjectSummary) {
    const confirmed = window.confirm(
      `Borrar "${p.name}"?\n\n` +
        `Se van a eliminar TAMBIEN los archivos generados: ${p.imageCount} imagenes y ` +
        `${p.clipCount} clips (carpeta output/${p.id}/).\n\nEsto NO se puede deshacer.`
    );
    if (!confirmed) return;

    setDeletingId(p.id);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/projects/${p.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "No se pudo borrar el proyecto");
      if (data.filesError) {
        setDeleteError(
          `Proyecto borrado, pero no se pudieron eliminar los archivos: ${data.filesError}`
        );
      }
      setProjects((prev) => prev.filter((x) => x.id !== p.id));
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(null);
    }
  }

  function applyPastedJson() {
    setPlanFromJson(jsonText);
  }

  /* ------------------ Importar carpeta con varios PlanJSON ------------------ */

  /** Path relativo dentro de la carpeta elegida (o el nombre suelto del archivo). */
  function relPathOf(f: File): string {
    return f.webkitRelativePath || f.name;
  }

  function patchImported(fileName: string, patch: Partial<ImportedPlan>) {
    setImported((prev) =>
      prev.map((i) => (i.fileName === fileName ? { ...i, ...patch } : i))
    );
  }

  /**
   * Lee una carpeta (o varios archivos) y valida cada .json con el MISMO Zod que
   * usa el backend. No crea nada todavia: primero te muestra que archivos estan
   * sanos y que errores tiene cada uno.
   */
  async function handleImportFiles(fileList: FileList | null) {
    setImportError(null);
    const files = Array.from(fileList ?? []).filter((f) => /\.json$/i.test(f.name));
    if (files.length === 0) {
      setImported([]);
      setImportError("No encontre ningun archivo .json en lo que elegiste.");
      return;
    }
    files.sort((a, b) =>
      relPathOf(a).localeCompare(relPathOf(b), "es", { numeric: true })
    );

    const out: ImportedPlan[] = [];
    for (const f of files) {
      const fileName = relPathOf(f);
      const name = f.name.replace(/\.json$/i, "");
      try {
        const raw = JSON.parse(await f.text());
        const validation = validatePlan(raw);
        if (!validation.ok) {
          out.push({
            fileName,
            name,
            plan: null,
            // Mostramos los primeros errores; con 6 ya se entiende que arreglar.
            errors: validation.errors
              .slice(0, 6)
              .map((e) => `${e.path || "plan"}: ${e.message}`),
            clipCount: 0,
            imageCount: 0,
            status: "invalido",
          });
          continue;
        }
        const plan = validation.plan;
        out.push({
          fileName,
          name,
          plan,
          errors: [],
          clipCount: plan.clips.length,
          imageCount: plan.assets.reduce((acc, asset) => acc + asset.images.length, 0),
          status: "listo",
        });
      } catch (err) {
        out.push({
          fileName,
          name,
          plan: null,
          errors: [
            `JSON invalido: ${err instanceof Error ? err.message : String(err)}`,
          ],
          clipCount: 0,
          imageCount: 0,
          status: "invalido",
        });
      }
    }
    setImported(out);
  }

  /**
   * Crea UN proyecto por cada JSON valido, en estado draft y SIN arrancar el
   * pipeline. Cuando termina, te manda al TABLERO del lote (/batch) donde
   * arrancás la generacion de imagenes y las revisás de a una.
   *
   * La auto-aprobacion se fuerza en OFF: el sentido del lote es revisar cada
   * imagen antes de que se gaste un video.
   */
  async function handleCreateImported() {
    const pendientes = imported.filter(
      (i) => i.plan && (i.status === "listo" || i.status === "error")
    );
    if (pendientes.length === 0) return;

    setImporting(true);
    setImportError(null);
    const createdIds: string[] = imported
      .filter((i) => i.status === "creado" && i.projectId)
      .map((i) => i.projectId as string);

    for (const item of pendientes) {
      patchImported(item.fileName, { status: "creando", createError: undefined });
      try {
        const res = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: item.name,
            brief: "",
            plan: item.plan,
            models: selectedModels,
            imageVariants,
            defaultResolution,
            // Revision de a una: nada se aprueba solo.
            autoApprove: false,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? "No se pudo crear el proyecto");
        const projectId = data.project.id as string;
        if (references.length > 0) await uploadReferences(projectId);
        patchImported(item.fileName, { status: "creado", projectId });
        createdIds.push(projectId);
      } catch (err) {
        patchImported(item.fileName, {
          status: "error",
          createError: err instanceof Error ? err.message : String(err),
        });
      }
    }
    setImporting(false);
    await loadProjects();

    // Al tablero del lote con los ids recien creados.
    if (createdIds.length > 0) {
      router.push(`/batch?ids=${createdIds.join(",")}`);
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
        body: JSON.stringify({
          name,
          brief,
          plan,
          models: selectedModels,
          imageVariants,
          defaultResolution,
          autoApprove,
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

        {/* Switch de auto-aprobacion del proyecto.
            - OFF (videos normales): cada imagen/video queda en "esperando aprobacion"
              y vos clickeas Aprobar antes de que arranque el siguiente paso.
            - ON  (VSL / dejar correr): cada job se aprueba solo al terminar.
            Default inteligente: se prende solo cuando subis avatares (VSL); si tocas
            el toggle a mano, mandamos lo que vos elegiste y no se ajusta mas. */}
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-800 bg-panel p-3 text-sm">
          <input
            type="checkbox"
            checked={autoApprove}
            onChange={(e) => setAutoApprove(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-accent"
          />
          <span className="flex-1">
            <span className="font-medium text-slate-100">
              Auto-aprobar todo al terminar
            </span>
            <span className="block text-xs text-slate-400">
              {autoApprove ? (
                <>
                  Modo <b>dejar correr</b>: cada imagen y video se aprueba sola y
                  arranca el siguiente. Recomendado para VSL con muchos clips.
                </>
              ) : (
                <>
                  Modo <b>aprobacion manual</b>: cada imagen y cada video te van a
                  pedir aprobacion antes de seguir. Ideal para videos normales con
                  pocas tomas.
                </>
              )}
            </span>
          </span>
        </label>

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

        {/* Avatares de referencia (VSL) — disponible en AMBOS modos (IA y Pegar PlanJSON).
            Subís las fotos de las personas y se usan como identidad: cada plano se
            genera manteniendo la misma cara (image2image). */}
        <div className="space-y-3 rounded-lg border border-slate-800 bg-panel p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                Avatares de referencia <span className="text-slate-500">(VSL · opcional)</span>
              </h3>
              <p className="text-xs text-slate-500">
                Subí las fotos de las personas (ej. 2). Se usan como fuente de identidad:
                todos los planos se generan manteniendo <b>la misma cara</b> (image2image).
                El <code>id</code> de cada foto tiene que coincidir con el de{" "}
                <code>references[]</code> en el plan (ej. <code>natalia</code>, <code>romina</code>).
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

          {/* Si el plan ya esta cargado, mostramos que ids de referencia espera. */}
          {plan?.references && plan.references.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-slate-700 bg-ink/60 p-2 text-[11px] text-slate-400">
              <span>El plan espera estos ids:</span>
              {plan.references.map((r) => {
                const ok = references.some((d) => d.id === r.id);
                return (
                  <code
                    key={r.id}
                    className={`rounded px-1.5 py-0.5 ${
                      ok
                        ? "bg-emerald-500/15 text-emerald-300"
                        : "bg-amber-500/15 text-amber-300"
                    }`}
                    title={ok ? "Foto subida ✓" : "Falta subir esta foto"}
                  >
                    {ok ? "✓ " : "• "}
                    {r.id}
                    {r.label ? ` (${r.label})` : ""}
                  </code>
                );
              })}
            </div>
          )}

          {references.length > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {references.map((r) => (
                <div
                  key={r.uid}
                  className="flex flex-col gap-2 rounded-lg border border-slate-700 bg-ink p-2"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={r.dataUrl}
                    alt={r.label || r.id}
                    className="aspect-[3/4] w-full rounded object-cover"
                  />
                  <label className="text-[10px] text-slate-500">
                    id (debe matchear el plan)
                    <input
                      value={r.id}
                      onChange={(e) => updateReference(r.uid, { id: e.target.value })}
                      placeholder="ej. natalia"
                      className="code mt-0.5 w-full rounded border border-slate-700 bg-panel px-2 py-1 text-xs text-slate-200 focus:border-accent focus:outline-none"
                    />
                  </label>
                  <input
                    value={r.label}
                    onChange={(e) => updateReference(r.uid, { label: e.target.value })}
                    placeholder="Nombre (ej. Natalia)"
                    className="rounded border border-slate-700 bg-panel px-2 py-1 text-xs focus:border-accent focus:outline-none"
                  />
                  <button
                    onClick={() => removeReference(r.uid)}
                    className="rounded px-1.5 py-0.5 text-[11px] text-red-300 hover:bg-red-500/10"
                    title="Quitar"
                  >
                    ✕ Quitar
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {mode === "ia" ? (
          <>
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

            {/* ---------------- Importar carpeta (lote de PlanJSON) ----------------
                Elegís una carpeta con N archivos .json (cada uno un PlanJSON completo)
                y se crea UN proyecto por archivo. No arranca ninguna generacion: por
                el rate limit los vas corriendo de a uno desde su pipeline. */}
            <div className="space-y-3 rounded-lg border border-slate-800 bg-panel p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-slate-100">
                    📁 Importar carpeta{" "}
                    <span className="text-slate-500">(varios proyectos de una)</span>
                  </h3>
                  <p className="text-xs text-slate-500">
                    Elegí una carpeta con varios <code>.json</code> (cada archivo = un
                    PlanJSON completo, igual al que pegás arriba). Se crea{" "}
                    <b>un proyecto por archivo</b>, en borrador y{" "}
                    <b>sin arrancar nada</b>. Cuando termina te lleva al{" "}
                    <b>tablero del lote</b>, donde arrancás la generación de imágenes y
                    las revisás de a una. La auto-aprobación queda <b>apagada</b> para
                    que ningún video se genere sin que vos apruebes la imagen.
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <label className="cursor-pointer rounded-lg border border-slate-600 px-3 py-2 text-sm hover:bg-slate-800">
                    📁 Elegir carpeta
                    <input
                      ref={folderInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={async (e) => {
                        await handleImportFiles(e.target.files);
                        e.target.value = "";
                      }}
                    />
                  </label>
                  <label className="cursor-pointer rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800">
                    📄 …o varios .json
                    <input
                      type="file"
                      multiple
                      accept=".json,application/json"
                      className="hidden"
                      onChange={async (e) => {
                        await handleImportFiles(e.target.files);
                        e.target.value = "";
                      }}
                    />
                  </label>
                </div>
              </div>

              {importError && (
                <p className="rounded bg-red-500/10 p-2 text-xs text-red-300">
                  {importError}
                </p>
              )}

              {imported.length > 0 && (
                <>
                  <div className="divide-y divide-slate-800 rounded-md border border-slate-700">
                    {imported.map((item) => (
                      <div
                        key={item.fileName}
                        className="flex flex-wrap items-start gap-2 px-3 py-2 text-xs"
                      >
                        <span className="w-5 shrink-0 text-center">
                          {item.status === "creado"
                            ? "✓"
                            : item.status === "creando"
                            ? "⏳"
                            : item.status === "invalido" || item.status === "error"
                            ? "✕"
                            : "•"}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <code className="text-slate-400">{item.fileName}</code>
                            {item.plan && (
                              <span className="text-slate-500">
                                {item.imageCount} imagenes · {item.clipCount} clips
                              </span>
                            )}
                            {item.status === "creado" && item.projectId && (
                              <Link
                                href={`/project/${item.projectId}/pipeline`}
                                className="text-accent hover:underline"
                              >
                                abrir →
                              </Link>
                            )}
                          </div>
                          {/* Nombre editable del proyecto (default: nombre del archivo). */}
                          {item.plan && item.status !== "creado" && (
                            <input
                              value={item.name}
                              onChange={(e) =>
                                patchImported(item.fileName, { name: e.target.value })
                              }
                              placeholder="Nombre del proyecto"
                              className="mt-1 w-full max-w-sm rounded border border-slate-700 bg-ink px-2 py-1 text-xs focus:border-accent focus:outline-none"
                            />
                          )}
                          {item.errors.length > 0 && (
                            <ul className="mt-1 space-y-0.5 text-red-300">
                              {item.errors.map((e, i) => (
                                <li key={i}>· {e}</li>
                              ))}
                            </ul>
                          )}
                          {item.createError && (
                            <p className="mt-1 text-red-300">· {item.createError}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      onClick={() => void handleCreateImported()}
                      disabled={
                        importing ||
                        imported.filter(
                          (i) => i.plan && (i.status === "listo" || i.status === "error")
                        ).length === 0
                      }
                      className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                    >
                      {importing
                        ? "Creando proyectos…"
                        : `Crear ${
                            imported.filter(
                              (i) =>
                                i.plan && (i.status === "listo" || i.status === "error")
                            ).length
                          } proyectos y abrir el tablero →`}
                    </button>
                    <button
                      onClick={() => {
                        setImported([]);
                        setImportError(null);
                      }}
                      disabled={importing}
                      className="rounded-lg border border-slate-600 px-3 py-2 text-sm hover:bg-slate-800 disabled:opacity-50"
                    >
                      Limpiar lista
                    </button>
                    <span className="text-xs text-slate-500">
                      {imported.filter((i) => i.status === "creado").length} creados ·{" "}
                      {imported.filter((i) => i.status === "invalido").length} invalidos
                      {references.length > 0 && (
                        <> · se suben {references.length} fotos de referencia a cada uno</>
                      )}
                    </span>
                  </div>
                </>
              )}
            </div>
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
                {autoApprove ? (
                  <>
                    Auto-aprobacion <b>activa</b>: las imagenes y videos se
                    aprueban solos al terminar.
                  </>
                ) : (
                  <>
                    Cada imagen y cada video van a pedirte <b>aprobacion</b>{" "}
                    antes de seguir.
                  </>
                )}{" "}
                Todo se guarda en{" "}
                <code className="text-slate-300">output/&lt;project_id&gt;/</code>.
              </p>
            </div>
          </div>
        </section>
      )}

      {projects.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Proyectos</h2>
          {deleteError && (
            <p className="rounded bg-red-500/10 p-2 text-sm text-red-300">
              {deleteError}
            </p>
          )}
          <div className="divide-y divide-slate-800 rounded-lg border border-slate-800">
            {projects.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-2 px-4 py-3 hover:bg-slate-800/50"
              >
                <Link href={`/project/${p.id}/pipeline`} className="min-w-0 flex-1">
                  <div className="truncate font-medium">{p.name}</div>
                  <div className="text-xs text-slate-500">
                    {p.imageCount} imagenes · {p.clipCount} clips ·{" "}
                    {new Date(p.createdAt).toLocaleString()}
                  </div>
                </Link>
                <StatusBadge status={p.status} />
                <button
                  onClick={() => void handleDeleteProject(p)}
                  disabled={deletingId === p.id}
                  title="Borrar el proyecto y TODOS sus archivos (imagenes y videos)"
                  className="shrink-0 rounded-md border border-red-900/60 px-2.5 py-1.5 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                >
                  {deletingId === p.id ? "Borrando…" : "🗑 Borrar"}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
