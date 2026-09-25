"use client";
/**
 * Pantalla de "Nuevo proyecto", en UN SOLO PASO: nombre, modelos y aprobacion,
 * brief/PlanJSON y el plan interpretado (clips, avatares, JSON y costo) viven en la
 * misma pantalla con scroll, y "Generar" queda fijo abajo.
 *
 * Antes era un wizard de 3 pasos y se bugeaba: el plan aparecia en el paso 3 y no
 * al lado del brief que lo generaba, se podia saltar pasos desde el stepper con
 * cosas a medio cargar, y el modelo que interpreta el brief se elegia en el paso 2,
 * DESPUES de haber interpretado. Ahora el orden de la pantalla es el orden real:
 * primero los modelos, despues el brief, y el plan aparece debajo apenas existe.
 *
 * ─── LO QUE NO CAMBIA ────────────────────────────────────────────────────────
 *
 * Es un rediseño VISUAL y de LAYOUT. Los handlers, los fetch, los payloads y el
 * orden de las llamadas son EXACTAMENTE los que tenia el formulario largo de
 * page.tsx antes del rediseño:
 *   1. POST /api/projects (crea el proyecto en draft)
 *   2. uploadReferences() del store (si hay avatares subidos)
 *   3. POST /api/projects/:id/generate (arranca el pipeline)
 *   4. router.push a /project/:id/pipeline
 * Ademas de la importacion en lote, que crea UN proyecto por archivo con el mismo
 * POST /api/projects (autoApprove forzado en false) y termina en /batch?ids=.
 *
 * `useProjectStore` es intocable desde aca: se lee y se llaman sus acciones, nada
 * mas.
 *
 * ─── EL id DE CADA AVATAR (no tocar la logica, solo el layout) ───────────────
 *
 * El `id` de una foto de referencia es la clave con la que el plan dice, en
 * `ref_image_ids`, "este plano es la cara de esta persona". Las tres cosas que lo
 * sostienen siguen igual que en el original:
 *   - key={r.uid}, NO r.id (el uid es estable; el id lo edita el usuario).
 *   - el onChange manda el id crudo; el store lo slugifica.
 *   - el indicador compara `d.id === r.id` EXACTO, sin normalizar de nuevo.
 */
import {
  ArrowRight,
  Check,
  ClipboardText,
  Code,
  FileArrowUp,
  FolderOpen,
  Play,
  Plus,
  Sparkle,
  UsersThree,
  Warning,
  X,
} from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { CostEstimatePanel } from "@/components/CostEstimatePanel";
import { ModelSelectorBar } from "@/components/ModelSelectorBar";
import { BarraInferior } from "@/components/Pantalla";
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Segmented,
  Textarea,
  ToggleCard,
} from "@/components/ui";
import { cn } from "@/lib/cn";
import { STORYBOARD_PROMPT_TEMPLATE } from "@/lib/prompts";
import { SAMPLE_BRIEF } from "@/lib/sampleBrief";
import { validatePlan, type ProjectPlan } from "@/lib/schema";
import type { Tone } from "@/lib/ui-tokens";
import { useProjectStore } from "@/store/useProjectStore";

type Mode = "ia" | "json";

/**
 * Un PlanJSON leido de un archivo al importar una carpeta en lote.
 * Se valida en el cliente (mismo Zod que el backend) ANTES de crear nada, asi
 * ves de una que archivos estan sanos y cuales tienen errores.
 */
interface ImportedPlan {
  fileName: string;
  name: string;
  plan: ProjectPlan | null;
  errors: string[];
  clipCount: number;
  imageCount: number;
  status: "listo" | "invalido" | "creando" | "creado" | "error";
  projectId?: string;
  createError?: string;
}

/**
 * Como se ve cada archivo de la importacion en lote. Son estados de un ARCHIVO en
 * esta pantalla, no estados de job ni de proyecto: no salen de `ui-tokens` ni de
 * ningun endpoint.
 */
const IMPORT_VISUAL: Record<
  ImportedPlan["status"],
  { tone: Tone; label: string; animado?: boolean }
> = {
  listo: { tone: "neutral", label: "Listo para crear" },
  invalido: { tone: "danger", label: "Inválido" },
  creando: { tone: "info", label: "Creando", animado: true },
  creado: { tone: "ok", label: "Creado" },
  error: { tone: "danger", label: "Error al crear" },
};

export function NuevoProyectoWizard({ onCreado }: { onCreado: () => void }) {
  const router = useRouter();
  const {
    config,
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
    parseBrief,
    setPlan,
    setPlanFromJson,
    addReferenceFile,
    updateReference,
    removeReference,
    uploadReferences,
  } = useProjectStore();

  const [name, setName] = useState("");
  const [mode, setMode] = useState<Mode>("ia");
  const [jsonText, setJsonText] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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

  function applyPastedJson() {
    setPlanFromJson(jsonText);
  }

  /* ------------------ Importar carpeta con varios PlanJSON ------------------ */

  function relPathOf(f: File): string {
    return f.webkitRelativePath || f.name;
  }

  function patchImported(fileName: string, patch: Partial<ImportedPlan>) {
    setImported((prev) =>
      prev.map((i) => (i.fileName === fileName ? { ...i, ...patch } : i)),
    );
  }

  async function handleImportFiles(fileList: FileList | null) {
    setImportError(null);
    const files = Array.from(fileList ?? []).filter((f) => /\.json$/i.test(f.name));
    if (files.length === 0) {
      setImported([]);
      setImportError("No encontre ningun archivo .json en lo que elegiste.");
      return;
    }
    files.sort((a, b) =>
      relPathOf(a).localeCompare(relPathOf(b), "es", { numeric: true }),
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

  async function handleCreateImported() {
    const pendientes = imported.filter(
      (i) => i.plan && (i.status === "listo" || i.status === "error"),
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
    onCreado();

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

      if (references.length > 0) {
        await uploadReferences(projectId);
      }

      const genRes = await fetch(`/api/projects/${projectId}/generate`, {
        method: "POST",
      });
      const genData = await genRes.json();
      if (!genRes.ok) throw new Error(genData.error ?? "No se pudo iniciar el pipeline");

      onCreado();
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

  /* ------------------------------ derivados ------------------------------ */

  const revisionJson = useMemo(() => {
    const texto = jsonText.trim();
    if (!texto) return null;
    let crudo: unknown;
    try {
      crudo = JSON.parse(texto);
    } catch (e) {
      return {
        ok: false as const,
        resumen: `No es JSON válido: ${e instanceof Error ? e.message : String(e)}`,
        detalles: [] as string[],
      };
    }
    const v = validatePlan(crudo);
    if (v.ok) {
      const imagenes = v.plan.assets.reduce((acc, a) => acc + a.images.length, 0);
      return {
        ok: true as const,
        resumen: `${imagenes} imágenes · ${v.plan.clips.length} clips · ${
          v.plan.references?.length ?? 0
        } avatares`,
        detalles: [] as string[],
      };
    }
    return {
      ok: false as const,
      resumen: `${v.errors.length} ${
        v.errors.length === 1 ? "campo no cumple" : "campos no cumplen"
      } el esquema del plan`,
      detalles: v.errors.slice(0, 8).map((e) => `${e.path || "plan"}: ${e.message}`),
    };
  }, [jsonText]);

  const idsQueEsperaElPlan = plan?.references ?? [];
  const modeloDelBrief =
    config?.catalog.llm.find((o) => o.id === selectedModels.llm)?.label ??
    selectedModels.llm;
  const pendientesDeImportar = imported.filter(
    (i) => i.plan && (i.status === "listo" || i.status === "error"),
  ).length;

  // Cuando aparece un plan (recien interpretado o recien cargado), se lleva la
  // pantalla hasta el: si no, queda debajo del brief y parece que no paso nada.
  //
  // Se scrollea SOLO el contenedor del formulario, a mano. `scrollIntoView` mueve
  // todos los ancestros scrolleables, incluido el shell de alto fijo de la app:
  // se iba el header de arriba y la barra de "Generar" quedaba flotando.
  const scrollRef = useRef<HTMLDivElement>(null);
  const planRef = useRef<HTMLElement>(null);
  const habiaPlan = useRef(false);
  useEffect(() => {
    const cont = scrollRef.current;
    const destino = planRef.current;
    if (plan && !habiaPlan.current && cont && destino) {
      const top =
        destino.getBoundingClientRect().top - cont.getBoundingClientRect().top + cont.scrollTop;
      cont.scrollTo({ top: top - 16, behavior: "smooth" });
    }
    habiaPlan.current = Boolean(plan);
  }, [plan]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
        <div className="mx-auto max-w-[1080px] space-y-10">
          <Input
            label="Nombre del proyecto"
            hint="Opcional. Vacío queda como “Proyecto” más la fecha."
            placeholder="ej. VSL Natalia"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />

          <SeccionModelos autoApprove={autoApprove} setAutoApprove={setAutoApprove} />

          <section className="space-y-3">
            <h2 className="text-title font-semibold text-fg">Brief</h2>
            <SeccionBrief
              mode={mode}
              setMode={setMode}
              brief={brief}
              setBrief={setBrief}
              parsing={parsing}
              error={error}
              parseBrief={parseBrief}
              modeloDelBrief={String(modeloDelBrief)}
              jsonText={jsonText}
              setJsonText={setJsonText}
              revisionJson={revisionJson}
              applyPastedJson={applyPastedJson}
              copied={copied}
              copyPromptTemplate={copyPromptTemplate}
              folderInputRef={folderInputRef}
              handleImportFiles={handleImportFiles}
              imported={imported}
              importing={importing}
              importError={importError}
              pendientesDeImportar={pendientesDeImportar}
              handleCreateImported={handleCreateImported}
              patchImported={patchImported}
              setImported={setImported}
              setImportError={setImportError}
              references={references}
            />
          </section>

          <section ref={planRef} className="space-y-3">
            <h2 className="text-title font-semibold text-fg">Plan</h2>
            <SeccionPlan
              plan={plan}
              estimate={estimate}
              references={references}
              idsQueEsperaElPlan={idsQueEsperaElPlan}
              addReferenceFile={addReferenceFile}
              updateReference={updateReference}
              removeReference={removeReference}
              setPlan={setPlan}
              autoApprove={autoApprove}
            />
          </section>
        </div>
      </div>

      {/* ─────────────────────────── footer fijo ─────────────────────────── */}
      <BarraInferior className="justify-between">
        {createError ? (
          <p role="alert" className="min-w-0 text-label text-danger">
            {createError}
          </p>
        ) : (
          <p className="min-w-0 text-label text-fg-dim">
            {plan
              ? "Revisá los clips y el costo antes de gastar."
              : "Interpretá un brief con IA o cargá un PlanJSON para poder generar."}
          </p>
        )}
        <Button
          variant="primary"
          icon={<Play className="size-4" aria-hidden />}
          loading={creating}
          disabled={!plan}
          onClick={() => void handleGenerateAll()}
        >
          Generar
        </Button>
      </BarraInferior>
    </div>
  );
}

/* ═══════════════════════════════ Brief ═══════════════════════════════ */

function SeccionBrief({
  mode,
  setMode,
  brief,
  setBrief,
  parsing,
  error,
  parseBrief,
  modeloDelBrief,
  jsonText,
  setJsonText,
  revisionJson,
  applyPastedJson,
  copied,
  copyPromptTemplate,
  folderInputRef,
  handleImportFiles,
  imported,
  importing,
  importError,
  pendientesDeImportar,
  handleCreateImported,
  patchImported,
  setImported,
  setImportError,
  references,
}: {
  mode: Mode;
  setMode: (v: Mode) => void;
  brief: string;
  setBrief: (v: string) => void;
  parsing: boolean;
  error: string | null;
  parseBrief: () => void;
  modeloDelBrief: string;
  jsonText: string;
  setJsonText: (v: string) => void;
  revisionJson: { ok: boolean; resumen: string; detalles: string[] } | null;
  applyPastedJson: () => void;
  copied: boolean;
  copyPromptTemplate: () => void;
  folderInputRef: React.RefObject<HTMLInputElement>;
  handleImportFiles: (files: FileList | null) => Promise<void>;
  imported: ImportedPlan[];
  importing: boolean;
  importError: string | null;
  pendientesDeImportar: number;
  handleCreateImported: () => Promise<void>;
  patchImported: (fileName: string, patch: Partial<ImportedPlan>) => void;
  setImported: (v: ImportedPlan[]) => void;
  setImportError: (v: string | null) => void;
  references: { id: string }[];
}) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          etiqueta="Modo de armar el plan"
          value={mode}
          onChange={setMode}
          options={[
            {
              value: "ia",
              label: (
                <span className="inline-flex items-center gap-1.5">
                  <Sparkle className="size-4" aria-hidden />
                  Brief con IA
                </span>
              ),
            },
            {
              value: "json",
              label: (
                <span className="inline-flex items-center gap-1.5">
                  <Code className="size-4" aria-hidden />
                  Pegar PlanJSON
                </span>
              ),
            },
          ]}
        />
        {mode === "json" && (
          <Button
            size="sm"
            variant="ghost"
            onClick={copyPromptTemplate}
            icon={
              copied ? (
                <Check className="size-3.5" aria-hidden />
              ) : (
                <ClipboardText className="size-3.5" aria-hidden />
              )
            }
            title="Copiá este prompt, pegalo en ChatGPT o Gemini con tu brief, y te devuelve el JSON exacto"
          >
            {copied ? "Prompt copiado" : "Copiar prompt para ChatGPT o Gemini"}
          </Button>
        )}
      </div>

      {mode === "ia" ? (
        <div className="space-y-3">
          <Textarea
            label="Brief del anuncio"
            hint={`Lo interpreta ${modeloDelBrief}. Se cambia en "Modelos", arriba.`}
            placeholder="Pegá acá tu brief largo con avatares, b-roll y clips en orden…"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            className="h-56 leading-relaxed"
            error={error ?? undefined}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              icon={<Sparkle className="size-4" aria-hidden />}
              loading={parsing}
              disabled={!brief.trim()}
              onClick={() => void parseBrief()}
            >
              Interpretar con IA
            </Button>
            <Button onClick={() => setBrief(SAMPLE_BRIEF)}>Cargar ejemplo</Button>
            <p aria-live="polite" className="text-label text-fg-dim">
              {parsing
                ? "Interpretando. Tarda entre 15 y 20 segundos: no lo apretes de nuevo."
                : !brief.trim()
                  ? "Pegá el brief para poder interpretarlo."
                  : "Devuelve el PlanJSON y la estimación de costo, sin generar nada."}
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-2">
            <Textarea
              label="PlanJSON"
              mono
              spellCheck={false}
              placeholder="Pegá acá el PlanJSON (el que te devolvió tu IA usando el prompt copiable)…"
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              className="code h-56 leading-relaxed"
              error={error ?? undefined}
            />
            {revisionJson && (
              <div
                className={cn(
                  "rounded-sm p-2",
                  revisionJson.ok ? "bg-ok/10" : "bg-danger/10",
                )}
              >
                <p className="flex flex-wrap items-center gap-2">
                  <Badge tone={revisionJson.ok ? "ok" : "danger"} punto>
                    {revisionJson.ok ? "Válido" : "Revisar"}
                  </Badge>
                  <span
                    className={cn(
                      "text-label",
                      revisionJson.ok ? "text-fg-dim" : "text-danger",
                    )}
                  >
                    {revisionJson.resumen}
                  </span>
                </p>
                {revisionJson.detalles.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5 text-label text-danger">
                    {revisionJson.detalles.map((d, i) => (
                      <li key={i} className="code">
                        {d}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <Button variant="primary" onClick={applyPastedJson} disabled={!jsonText.trim()}>
            Cargar PlanJSON
          </Button>

          {/* ---------------- Importar carpeta (lote de PlanJSON) ---------------- */}
          <Card className="space-y-3">
            <CardHeader>
              <div className="min-w-0">
                <CardTitle className="flex items-center gap-2">
                  <FolderOpen className="size-4 shrink-0 text-fg-dim" aria-hidden />
                  Importar carpeta
                </CardTitle>
                <CardDescription className="mt-1 max-w-prose text-label">
                  Elegí una carpeta con varios <code className="code text-fg">.json</code>{" "}
                  (cada archivo un PlanJSON completo, igual al que pegás arriba). Se crea{" "}
                  <b className="font-medium text-fg">un proyecto por archivo</b>, en
                  borrador y <b className="font-medium text-fg">sin arrancar nada</b>.
                  Cuando termina te lleva al tablero del lote, donde arrancás la
                  generación de imágenes y las revisás de a una. La auto-aprobación
                  queda <b className="font-medium text-fg">apagada</b>, así ningún video
                  se genera sin que vos apruebes la imagen.
                </CardDescription>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <BotonDeArchivo
                  refDelInput={folderInputRef}
                  multiple
                  onChange={async (e) => {
                    await handleImportFiles(e.target.files);
                    e.target.value = "";
                  }}
                >
                  <FolderOpen className="size-4" aria-hidden />
                  Elegir carpeta
                </BotonDeArchivo>
                <BotonDeArchivo
                  multiple
                  accept=".json,application/json"
                  onChange={async (e) => {
                    await handleImportFiles(e.target.files);
                    e.target.value = "";
                  }}
                >
                  <FileArrowUp className="size-4" aria-hidden />
                  …o varios .json
                </BotonDeArchivo>
              </div>
            </CardHeader>

            {importError && (
              <p role="alert" className="rounded-sm bg-danger/10 p-2 text-label text-danger">
                {importError}
              </p>
            )}

            {imported.length > 0 && (
              <>
                <ul className="divide-y divide-divider overflow-hidden rounded-lg bg-bg">
                  {imported.map((item) => (
                    <FilaImportada
                      key={item.fileName}
                      item={item}
                      onRenombrar={(v) => patchImported(item.fileName, { name: v })}
                    />
                  ))}
                </ul>

                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="primary"
                    icon={<ArrowRight className="size-4" aria-hidden />}
                    loading={importing}
                    disabled={pendientesDeImportar === 0}
                    onClick={() => void handleCreateImported()}
                  >
                    Crear {pendientesDeImportar} proyectos y abrir el tablero
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={importing}
                    onClick={() => {
                      setImported([]);
                      setImportError(null);
                    }}
                  >
                    Limpiar lista
                  </Button>
                  <p className="text-label text-fg-dim">
                    <span className="code tnum text-fg">
                      {imported.filter((i) => i.status === "creado").length}
                    </span>{" "}
                    creados ·{" "}
                    <span className="code tnum text-fg">
                      {imported.filter((i) => i.status === "invalido").length}
                    </span>{" "}
                    inválidos
                    {references.length > 0 && (
                      <>
                        {" · se suben "}
                        <span className="code tnum text-fg">{references.length}</span>
                        {" fotos de referencia a cada uno"}
                      </>
                    )}
                  </p>
                </div>
              </>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════ Modelos y aprobación ═══════════════════════ */

function SeccionModelos({
  autoApprove,
  setAutoApprove,
}: {
  autoApprove: boolean;
  setAutoApprove: (v: boolean) => void;
}) {
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-title font-semibold text-fg">Modelos</h2>
        <ModelSelectorBar />
      </section>

      <section className="space-y-3">
        <h2 className="text-title font-semibold text-fg">Aprobación</h2>
        {/*
          ToggleCard reemplaza al checkbox custom del formulario original: mismo
          significado (autoApprove del store), misma explicacion del gate por
          lotes, ahora con el componente que el sistema de diseño ya define para
          este patron exacto (ver el comentario de ui/ToggleCard.tsx).
        */}
        <ToggleCard
          activo={autoApprove}
          onChange={setAutoApprove}
          title="Aprobar solo"
          descripcion={
            autoApprove ? (
              <>
                Modo <b className="font-medium text-fg">dejar correr</b>: cada
                imagen y cada video se aprueban solos al terminar y arranca el
                siguiente. Recomendado para un VSL con muchos clips.
              </>
            ) : (
              <>
                Modo <b className="font-medium text-fg">aprobación manual</b>: cada
                imagen y cada video te van a pedir aprobación antes de seguir (el
                gate por lotes). Ideal para videos normales con pocas tomas.
              </>
            )
          }
        />
      </section>
    </div>
  );
}

/* ═══════════════════════════════ Plan ═══════════════════════════════ */

function SeccionPlan({
  plan,
  estimate,
  references,
  idsQueEsperaElPlan,
  addReferenceFile,
  updateReference,
  removeReference,
  setPlan,
  autoApprove,
}: {
  plan: ProjectPlan | null;
  estimate: import("@/store/useProjectStore").CostEstimate | null;
  references: import("@/store/useProjectStore").ReferenceDraft[];
  idsQueEsperaElPlan: { id: string; label?: string }[];
  addReferenceFile: (f: File) => Promise<void>;
  updateReference: (
    uid: string,
    patch: Partial<Pick<import("@/store/useProjectStore").ReferenceDraft, "id" | "label">>,
  ) => void;
  removeReference: (uid: string) => void;
  setPlan: (p: ProjectPlan) => void;
  autoApprove: boolean;
}) {
  if (!plan) {
    return (
      <Card className="flex flex-col items-start gap-1 border border-dashed border-divider bg-transparent px-5 py-8">
        <p className="text-title font-semibold text-fg">Todavía no hay un plan cargado</p>
        <p className="max-w-prose text-body text-fg-dim">
          Interpretá el brief con IA o cargá un PlanJSON (arriba) y el plan aparece
          acá para revisarlo antes de generar.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {(plan.warnings?.length ?? 0) > 0 && (
        <ul className="space-y-1 rounded-lg bg-accent/10 p-3 text-label text-accent">
          {plan.warnings.map((w, i) => (
            <li key={i} className="flex gap-2">
              <Warning className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        {/* ── columna izquierda: tabla de clips + avatares ── */}
        <div className="space-y-6">
          <section className="space-y-2">
            <h2 className="text-title font-semibold text-fg">Clips del plan</h2>
            <div className="overflow-hidden rounded-lg bg-surface">
              <table className="w-full text-left text-label">
                <thead>
                  <tr className="border-b border-divider text-fg-dim">
                    <th className="px-3 py-2 font-medium">#</th>
                    <th className="px-3 py-2 font-medium">id</th>
                    <th className="px-3 py-2 font-medium">duración</th>
                    <th className="px-3 py-2 font-medium">diálogo</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-divider">
                  {plan.clips.map((c) => {
                    const filmarReal = c.etiqueta === "FILMAR_REAL";
                    return (
                      <tr
                        key={c.id}
                        className={cn(filmarReal && "bg-accent/10")}
                      >
                        <td className="code tnum px-3 py-2 text-fg-dim">{c.orden}</td>
                        <td
                          className={cn(
                            "code px-3 py-2",
                            filmarReal ? "font-medium text-accent" : "text-fg",
                          )}
                        >
                          {c.id}
                          {filmarReal && (
                            <span className="ml-1.5 text-label font-normal">
                              (FILMAR_REAL)
                            </span>
                          )}
                        </td>
                        <td className="code tnum px-3 py-2 text-fg-dim">
                          {c.duracion_seg}s
                        </td>
                        <td className="max-w-sm truncate px-3 py-2 text-fg-dim">
                          {c.dialogo || <span className="text-fg-dim/60">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* ── avatares de referencia (VSL) ── */}
          <Card className="space-y-4">
            <CardHeader>
              <div className="min-w-0">
                <CardTitle className="flex items-center gap-2">
                  <UsersThree className="size-4 shrink-0 text-fg-dim" aria-hidden />
                  Avatares de referencia
                  <span className="text-label font-normal text-fg-dim">
                    VSL · opcional
                  </span>
                </CardTitle>
                <CardDescription className="mt-1 max-w-prose text-label">
                  Subí las fotos de las personas. Se usan como fuente de identidad:
                  todos los planos se generan manteniendo{" "}
                  <b className="font-medium text-fg">la misma cara</b> (image2image).
                  El <code className="code text-fg">id</code> de cada foto tiene que
                  coincidir con el de <code className="code text-fg">references[]</code>{" "}
                  en el plan.
                </CardDescription>
              </div>
              <BotonDeArchivo
                accept="image/png,image/jpeg,image/webp"
                multiple
                onChange={async (e) => {
                  const files = Array.from(e.target.files ?? []);
                  for (const f of files) await addReferenceFile(f);
                  e.target.value = "";
                }}
              >
                <Plus className="size-4" aria-hidden />
                Agregar foto
              </BotonDeArchivo>
            </CardHeader>

            {idsQueEsperaElPlan.length > 0 && (
              <div className="space-y-1.5 rounded-sm bg-surface-hi p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-label text-fg-dim">El plan espera estos ids:</span>
                  {idsQueEsperaElPlan.map((r) => {
                    const ok = references.some((d) => d.id === r.id);
                    return (
                      <Badge key={r.id} tone={ok ? "ok" : "attention"} punto={!ok}>
                        {ok && <Check className="size-3.5 shrink-0" aria-hidden />}
                        <span className="code">{r.id}</span>
                        {r.label ? (
                          <span className="font-normal">({r.label})</span>
                        ) : null}
                      </Badge>
                    );
                  })}
                </div>
                <p className="text-label text-fg-dim">
                  El tilde es una foto ya subida con ese id. El punto es una que
                  falta: esos planos se van a generar sin la cara de referencia.
                </p>
              </div>
            )}

            {references.length > 0 ? (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {references.map((r) => {
                  const usadaPorElPlan = idsQueEsperaElPlan.some((p) => p.id === r.id);
                  return (
                    <li key={r.uid} className="space-y-2 rounded-lg bg-surface-hi p-2">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={r.dataUrl}
                        alt={r.label || r.id}
                        className="aspect-[3/4] w-full rounded-sm object-cover"
                      />
                      <Input
                        label="id (tiene que matchear el plan)"
                        placeholder="ej. natalia"
                        value={r.id}
                        onChange={(e) => updateReference(r.uid, { id: e.target.value })}
                        className="code"
                      />
                      <Input
                        label="Nombre"
                        placeholder="ej. Natalia"
                        value={r.label}
                        onChange={(e) =>
                          updateReference(r.uid, { label: e.target.value })
                        }
                      />
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        {idsQueEsperaElPlan.length > 0 ? (
                          usadaPorElPlan ? (
                            <Badge tone="ok">
                              <Check className="size-3.5 shrink-0" aria-hidden />
                              en el plan
                            </Badge>
                          ) : (
                            <Badge tone="attention" punto>
                              sin usar
                            </Badge>
                          )
                        ) : (
                          <span />
                        )}
                        <Button
                          size="sm"
                          variant="danger"
                          icon={<X className="size-3.5" aria-hidden />}
                          onClick={() => removeReference(r.uid)}
                        >
                          Quitar
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-label text-fg-dim">
                Todavía no subiste ninguna. Si el anuncio no tiene una persona fija,
                dejalo vacío: cada imagen se genera desde su prompt.
              </p>
            )}
          </Card>

          {/* JSON crudo, editable: mismo mecanismo que antes (JsonEditor validaba y
              llamaba setPlan). Se deja como textarea simple con validacion en vivo
              para no importar JsonEditor con un layout que no es el suyo; el flujo
              (editar -> validar -> setPlan) es el mismo. */}
          <EditorDePlan plan={plan} setPlan={setPlan} />
        </div>

        {/* ── columna derecha: estimacion STICKY ── */}
        <div className="space-y-4 lg:sticky lg:top-0 lg:self-start">
          {estimate ? (
            <CostEstimatePanel estimate={estimate} />
          ) : (
            <Card>
              <CardTitle>Sin estimación previa</CardTitle>
              <CardDescription className="mt-1 text-label">
                La estimación la calcula el interpretador del brief. Este plan se
                cargó a mano, así que el costo aparece recién en el pipeline, con el
                proyecto ya creado.
              </CardDescription>
            </Card>
          )}

          {/* "Generar" vive en la barra fija de abajo: siempre a mano, sin scrollear. */}
          <Card className="space-y-3">
            <p className="text-label text-fg-dim">
              {autoApprove ? (
                <>
                  Auto-aprobación <b className="font-medium text-fg">activa</b>: las
                  imágenes y los videos se aprueban solos al terminar.
                </>
              ) : (
                <>
                  Cada imagen y cada video te van a pedir{" "}
                  <b className="font-medium text-fg">aprobación</b> antes de seguir.
                </>
              )}{" "}
              Todo se guarda en <code className="code text-fg">output/&lt;project_id&gt;/</code>.
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}

/**
 * Editor de texto plano del PlanJSON, con la misma validacion en vivo del modo
 * JSON de la sección Brief. Reemplaza a `<JsonEditor>` en la sección Plan: JsonEditor esta
 * pensado para un layout de dos columnas fijo, y aca la columna derecha la ocupa la
 * estimacion sticky. La logica (parsear, validar con el MISMO Zod, y solo llamar
 * `setPlan` si es valido) es la misma que hacia JsonEditor.
 */
function EditorDePlan({
  plan,
  setPlan,
}: {
  plan: ProjectPlan;
  setPlan: (p: ProjectPlan) => void;
}) {
  const [texto, setTexto] = useState(() => JSON.stringify(plan, null, 2));
  const [errorLocal, setErrorLocal] = useState<string | null>(null);

  useEffect(() => {
    setTexto(JSON.stringify(plan, null, 2));
  }, [plan]);

  function onChange(v: string) {
    setTexto(v);
    try {
      const parsed = JSON.parse(v);
      const validation = validatePlan(parsed);
      if (!validation.ok) {
        setErrorLocal(
          validation.errors[0]
            ? `${validation.errors[0].path || "plan"}: ${validation.errors[0].message}`
            : "El plan no cumple el esquema.",
        );
        return;
      }
      setErrorLocal(null);
      setPlan(validation.plan);
    } catch (e) {
      setErrorLocal(e instanceof Error ? e.message : "JSON inválido");
    }
  }

  return (
    <Textarea
      label="PlanJSON (editable)"
      mono
      spellCheck={false}
      value={texto}
      onChange={(e) => onChange(e.target.value)}
      error={errorLocal ?? undefined}
      className="code h-64 leading-relaxed"
    />
  );
}

/** Un `<input type="file">` con forma de boton. Igual al del formulario original. */
function BotonDeArchivo({
  children,
  refDelInput,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "className"> & {
  children: React.ReactNode;
  refDelInput?: React.Ref<HTMLInputElement>;
}) {
  return (
    <Button asChild>
      <label className="cursor-pointer focus-within:ring-2 focus-within:ring-accent focus-within:ring-offset-2 focus-within:ring-offset-bg">
        {children}
        <input ref={refDelInput} type="file" className="sr-only" {...props} />
      </label>
    </Button>
  );
}

/** Una fila de la importacion en lote: el archivo, su estado y su nombre editable. */
function FilaImportada({
  item,
  onRenombrar,
}: {
  item: ImportedPlan;
  onRenombrar: (v: string) => void;
}) {
  const visual = IMPORT_VISUAL[item.status];
  return (
    <li className="space-y-2 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={visual.tone} punto animado={visual.animado}>
          {visual.label}
        </Badge>
        <code className="code min-w-0 flex-1 truncate text-label text-fg">
          {item.fileName}
        </code>
        {item.plan && (
          <span className="shrink-0 text-label text-fg-dim">
            <span className="code tnum text-fg">{item.imageCount}</span> imágenes ·{" "}
            <span className="code tnum text-fg">{item.clipCount}</span> clips
          </span>
        )}
        {item.status === "creado" && item.projectId && (
          <Link
            href={`/project/${item.projectId}/pipeline`}
            className="inline-flex shrink-0 items-center gap-1 rounded-sm text-label font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            abrir
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        )}
      </div>

      {item.plan && item.status !== "creado" && (
        <div className="max-w-sm">
          <Input
            label="Nombre del proyecto"
            labelOculto
            placeholder="Nombre del proyecto"
            value={item.name}
            onChange={(e) => onRenombrar(e.target.value)}
          />
        </div>
      )}

      {item.errors.length > 0 && (
        <ul className="space-y-0.5 text-label text-danger">
          {item.errors.map((e, i) => (
            <li key={i} className="code">
              {e}
            </li>
          ))}
        </ul>
      )}
      {item.createError && <p className="text-label text-danger">{item.createError}</p>}
    </li>
  );
}
