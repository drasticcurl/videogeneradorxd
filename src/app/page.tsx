"use client";
/**
 * Home — el punto de entrada: de un brief (o de un PlanJSON ya armado) a un proyecto
 * con su pipeline corriendo.
 *
 * Estructura (§3 de T05):
 *   1. el modo, en pestañas: interpretar un brief con la IA, o pegar el PlanJSON
 *   2. el area de trabajo del modo elegido
 *   3. avatares de referencia (VSL), visibles en los dos modos
 *   4. modelos, aprobacion y costo estimado, pegados al boton de generar
 *   5. proyectos recientes en grilla, con vacio y carga de verdad
 *
 * ─── LO QUE NO CAMBIO ────────────────────────────────────────────────────────
 *
 * El rediseño es VISUAL. Los handlers son los mismos, con los mismos fetch, los
 * mismos payloads y el mismo orden: crear el proyecto, subir las referencias, y
 * recien ahi arrancar el pipeline. `useProjectStore` es intocable: desde aca se lee
 * y se llaman sus acciones, nada mas.
 *
 * ─── LO DELICADO: EL id DE CADA AVATAR ───────────────────────────────────────
 *
 * El `id` de una foto de referencia es la clave con la que el plan dice, en
 * `ref_image_ids`, "este plano es la cara de esta persona". Si el mapeo se rompe, el
 * VSL genera la cara equivocada y no se nota hasta ver el video.
 *
 * Las tres cosas que lo sostienen, y que no hay que tocar:
 *
 *   - la key de cada tarjeta es `r.uid`, NO `r.id`. El uid es estable; el id lo edita
 *     el usuario. Con `key={r.id}` React remonta el input en cada tecla, se pierde el
 *     foco y con el la mitad de lo que estabas escribiendo.
 *   - el onChange manda `updateReference(r.uid, { id: e.target.value })` crudo. El
 *     store slugifica y el input muestra el resultado, asi que escribir "Natalia F"
 *     queda "natalia_f" mientras tipeas. Es a proposito: es el mismo slug con el que
 *     el backend nombra el archivo.
 *   - el indicador compara `d.id === r.id` EXACTO contra los ids que el plan espera.
 *     Sin volver a normalizar y sin trim: si no matchea exacto, no matchea.
 */
import {
  ArrowRight,
  Check,
  ClipboardText,
  Code,
  FileArrowUp,
  FilmSlate,
  FolderOpen,
  Play,
  Plus,
  Sparkle,
  Trash,
  UsersThree,
  Warning,
  X,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { CostEstimatePanel } from "@/components/CostEstimatePanel";
import { JsonEditor } from "@/components/JsonEditor";
import { ModelSelectorBar } from "@/components/ModelSelectorBar";
import { StatusBadge } from "@/components/StatusBadge";
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Confirmar,
  EmptyState,
  Input,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@/components/ui";
import { cn } from "@/lib/cn";
import { STORYBOARD_PROMPT_TEMPLATE } from "@/lib/prompts";
import { SAMPLE_BRIEF } from "@/lib/sampleBrief";
import { validatePlan, type ProjectPlan } from "@/lib/schema";
import type { Tone } from "@/lib/ui-tokens";
import { useProjectStore } from "@/store/useProjectStore";

interface ProjectSummary {
  id: string;
  name: string;
  status: "draft" | "running" | "review" | "done" | "failed" | "partial" | "paused";
  createdAt: string;
  clipCount: number;
  imageCount: number;
  /** true = proyecto de la pantalla de solo imagenes; no va en esta lista. */
  soloImagenes?: boolean;
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

/**
 * Como se ve cada archivo de la importacion en lote.
 *
 * Son estados de un ARCHIVO en esta pantalla, no estados de job ni de proyecto: no
 * existen en `ui-tokens` y no salen de ningun endpoint. Van con `Tone`, asi que acá
 * no hay ni un color: la traduccion de tono a clases sigue siendo de `Badge` y de
 * nadie mas, que es lo que §6 del plan quiere garantizar.
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

/** Estado de la lista de proyectos. Sin esto, "cargando" y "no hay" se ven igual. */
type CargaLista = "cargando" | "listo" | "error";

export default function HomePage() {
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
  const [cargaLista, setCargaLista] = useState<CargaLista>("cargando");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /** El proyecto que el usuario pidio borrar, esperando confirmacion. */
  const [aBorrar, setABorrar] = useState<ProjectSummary | null>(null);

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
    setCargaLista("cargando");
    try {
      const res = await fetch("/api/projects");
      const data = await res.json();
      /*
        Se filtran los proyectos de SOLO IMAGENES: viven en /imagenes y tienen su
        propia lista. Antes caian todos juntos acá y quedaban mezclados los VSL con
        las tandas de imagenes, que no comparten ni pantalla ni acciones.
      */
      const todos = (data.projects ?? []) as ProjectSummary[];
      setProjects(todos.filter((p) => !p.soloImagenes));
      setCargaLista("listo");
    } catch {
      // Antes esto se tragaba en silencio y la lista quedaba vacia, que era
      // indistinguible de "todavia no hay proyectos". Con el vacio explicito de abajo
      // eso pasaria a ser una mentira, asi que el fallo se muestra.
      setCargaLista("error");
    }
  }

  /**
   * Borra un proyecto: registro en db.json + jobs + logs + la carpeta
   * output/<id>/ ENTERA (imagenes, clips, referencias, el video unido).
   * Es irreversible, y por eso pasa por el dialogo de confirmacion, que muestra
   * cuantos archivos se pierden.
   */
  async function handleDeleteProject(p: ProjectSummary) {
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

  /* ------------------------------ derivados ------------------------------ */

  /**
   * Validacion en vivo de lo que hay pegado en el textarea del modo JSON, con el
   * MISMO validador que corre el backend. No decide nada: el boton sigue haciendo
   * exactamente lo que hacia (cargar el texto tal cual, aunque no cumpla el
   * esquema, para poder arreglarlo en el editor de abajo). Es solo para que el
   * error se vea ANTES de apretar, en lugar de despues.
   */
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

  /** Los ids de referencia que el plan cargado espera. Vacio si no hay plan. */
  const idsQueEsperaElPlan = plan?.references ?? [];
  /** Etiqueta comercial del modelo que va a interpretar el brief. */
  const modeloDelBrief =
    config?.catalog.llm.find((o) => o.id === selectedModels.llm)?.label ??
    selectedModels.llm;
  const pendientesDeImportar = imported.filter(
    (i) => i.plan && (i.status === "listo" || i.status === "error")
  ).length;

  return (
    <div className="space-y-8">
      {/* ─────────────────────────── encabezado ─────────────────────────── */}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-display font-semibold text-fg">Nuevo proyecto</h1>
          <p className="mt-1 max-w-prose text-body text-fg-dim">
            Armá el plan desde un brief o pegá uno ya hecho. Nada se genera —y nada se
            cobra— hasta que apretes <b className="font-medium text-fg">Generar todo</b>.
          </p>
        </div>
        <div className="w-full sm:w-72">
          <Input
            label="Nombre del proyecto"
            hint="Opcional. Vacío queda como “Proyecto” más la fecha."
            placeholder="ej. VSL Natalia"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </header>

      {/* ─── 1: modelos, aprobacion y costo ───
           Va primero a proposito: el modelo de chat es el que interpreta el brief,
           asi que la decision (y su costo) tiene que estar tomada antes de apretar
           Interpretar con IA. ─── */}
      <section className="space-y-3">
        <h2 className="text-title font-semibold text-fg">Modelos y aprobación</h2>
        <ModelSelectorBar />

        {/* Switch de auto-aprobacion del proyecto.
            - OFF (videos normales): cada imagen/video queda esperando que vos la
              apruebes antes de que arranque el paso siguiente.
            - ON  (VSL / dejar correr): cada job se aprueba solo al terminar.
            Default inteligente del store: se prende solo cuando subis avatares (VSL);
            si tocás el toggle a mano, manda lo que elegiste y no se ajusta mas. */}
        <Card flush>
          <label className="flex cursor-pointer items-start gap-3 rounded-lg p-4 focus-within:ring-2 focus-within:ring-accent">
            <input
              type="checkbox"
              checked={autoApprove}
              onChange={(e) => setAutoApprove(e.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-accent"
            />
            <span className="min-w-0 flex-1">
              <span className="block text-body font-medium text-fg">
                Auto-aprobar todo al terminar
              </span>
              <span className="mt-0.5 block max-w-prose text-label text-fg-dim">
                {autoApprove ? (
                  <>
                    Modo <b className="font-medium text-fg">dejar correr</b>: cada imagen
                    y cada video se aprueban solos y arranca el siguiente. Es lo
                    recomendado para un VSL con muchos clips.
                  </>
                ) : (
                  <>
                    Modo <b className="font-medium text-fg">aprobación manual</b>: cada
                    imagen y cada video te van a pedir aprobación antes de seguir. Ideal
                    para videos normales con pocas tomas.
                  </>
                )}
              </span>
            </span>
          </label>
        </Card>
      </section>

      {/* ──────────────────── 2 y 3: modo + area de trabajo ─────────────── */}
      <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-divider">
          <TabsList className="border-b-0">
            {/* inline-flex: el <button> de Radix no lo es, y sin esto el icono y el
                texto se alinean por la linea de base y el icono queda hundido. */}
            <TabsTrigger value="ia" className="inline-flex items-center gap-1.5">
              <Sparkle className="size-4" aria-hidden />
              Interpretar brief
            </TabsTrigger>
            <TabsTrigger value="json" className="inline-flex items-center gap-1.5">
              <Code className="size-4" aria-hidden />
              Pegar PlanJSON
            </TabsTrigger>
          </TabsList>
          {/*
            Fuera del TabsList a proposito: adentro, un boton comun queda dentro de un
            role="tablist" y el lector de pantalla lo cuenta como una pestaña mas.
          */}
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
            {copied ? "Prompt copiado" : "Copiar prompt para tu IA"}
          </Button>
        </div>

        {/* ── modo A: la IA interpreta el brief ── */}
        <TabsContent value="ia" className="space-y-3">
          <Textarea
            label="Brief del anuncio"
            hint={`Lo interpreta ${modeloDelBrief}. Se cambia arriba, en Modelos y aprobación.`}
            placeholder="Pegá acá tu brief largo con avatares, b-roll y clips en orden…"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            className="h-56 leading-relaxed"
            error={mode === "ia" ? error ?? undefined : undefined}
          />
          <div className="flex flex-wrap items-center gap-3">
            {/*
              `loading` deshabilita solo y no cambia el texto (§5 regla 1). Los dos
              juntos dan el mismo disabled que antes: parsing || brief vacio.
              Importa mas que en otros botones: la interpretacion tarda entre 15 y 20
              segundos, y sin feedback el usuario aprieta de nuevo y paga dos veces.
            */}
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
        </TabsContent>

        {/* ── modo B: el PlanJSON ya viene hecho ── */}
        <TabsContent value="json" className="space-y-4">
          <div className="space-y-2">
            <Textarea
              label="PlanJSON"
              mono
              spellCheck={false}
              placeholder="Pegá acá el PlanJSON (el que te devolvió tu IA usando el prompt copiable)…"
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              className="code h-56 leading-relaxed"
              error={mode === "json" ? error ?? undefined : undefined}
            />
            {/*
              El detalle del validador, ABAJO del campo (§4 de T05). Se muestra
              mientras escribis y NO bloquea el boton: cargar un plan incompleto y
              arreglarlo en el editor de abajo es un camino valido y era el de antes.
            */}
            {revisionJson && (
              <div
                className={cn(
                  "rounded-sm p-2",
                  revisionJson.ok ? "bg-ok/10" : "bg-danger/10"
                )}
              >
                <p className="flex flex-wrap items-center gap-2">
                  <Badge tone={revisionJson.ok ? "ok" : "danger"} punto>
                    {revisionJson.ok ? "Válido" : "Revisar"}
                  </Badge>
                  <span
                    className={cn(
                      "text-label",
                      revisionJson.ok ? "text-fg-dim" : "text-danger"
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

          <Button
            variant="primary"
            onClick={applyPastedJson}
            disabled={!jsonText.trim()}
          >
            Cargar PlanJSON
          </Button>

          {/* ---------------- Importar carpeta (lote de PlanJSON) ----------------
              Elegís una carpeta con N archivos .json (cada uno un PlanJSON completo)
              y se crea UN proyecto por archivo. No arranca ninguna generacion: por
              el rate limit los vas corriendo de a uno desde su pipeline. */}
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
        </TabsContent>
      </Tabs>

      {/* ──────────────────── 4: avatares de referencia ──────────────────── */}
      {/*
        Visible en los DOS modos, como antes. Es lo mas delicado de la pantalla: el
        `id` de cada foto es lo que el plan referencia en `ref_image_ids`. Ver el
        comentario de arriba del archivo antes de tocar algo de este bloque.
      */}
      <Card className="space-y-4">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              <UsersThree className="size-4 shrink-0 text-fg-dim" aria-hidden />
              Avatares de referencia
              <span className="text-label font-normal text-fg-dim">VSL · opcional</span>
            </CardTitle>
            <CardDescription className="mt-1 max-w-prose text-label">
              Subí las fotos de las personas. Se usan como fuente de identidad: todos
              los planos se generan manteniendo{" "}
              <b className="font-medium text-fg">la misma cara</b> (image2image). El{" "}
              <code className="code text-fg">id</code> de cada foto tiene que coincidir
              con el de <code className="code text-fg">references[]</code> en el plan
              (ej. <code className="code text-fg">natalia</code>,{" "}
              <code className="code text-fg">romina</code>).
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

        {/* Si el plan ya esta cargado, mostramos que ids de referencia espera. */}
        {idsQueEsperaElPlan.length > 0 && (
          <div className="space-y-1.5 rounded-sm bg-surface-hi p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-label text-fg-dim">El plan espera estos ids:</span>
              {idsQueEsperaElPlan.map((r) => {
                // La comparacion del mapeo. EXACTA, sin normalizar de nuevo: es la
                // misma que decide si el pipeline encuentra la foto de esa cara.
                const ok = references.some((d) => d.id === r.id);
                return (
                  <Badge key={r.id} tone={ok ? "ok" : "attention"} punto={!ok}>
                    {ok && <Check className="size-3.5 shrink-0" aria-hidden />}
                    <span className="code">{r.id}</span>
                    {r.label ? <span className="font-normal">({r.label})</span> : null}
                  </Badge>
                );
              })}
            </div>
            {/* Leyenda escrita, no un tooltip: el title no existe para el teclado. */}
            <p className="text-label text-fg-dim">
              El tilde es una foto ya subida con ese id. El punto es una que falta:
              esos planos se van a generar sin la cara de referencia.
            </p>
          </div>
        )}

        {references.length > 0 ? (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {references.map((r) => {
              // Al reves que arriba: esta foto, ¿la usa el plan? Solo tiene sentido
              // preguntarlo cuando hay un plan cargado con referencias.
              const usadaPorElPlan = idsQueEsperaElPlan.some((p) => p.id === r.id);
              return (
                // key={r.uid} y NO r.id: el id lo esta editando el usuario y con el
                // como key React remonta el input en cada tecla.
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
                    onChange={(e) => updateReference(r.uid, { label: e.target.value })}
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
            Todavía no subiste ninguna. Si el anuncio no tiene una persona fija, dejalo
            vacío: cada imagen se genera desde su prompt.
          </p>
        )}
      </Card>

      {/* ─────────── el plan, la estimacion y el boton que gasta ─────────── */}
      {plan && (
        <section className="space-y-3">
          <h2 className="text-title font-semibold text-fg">Revisá el plan y generá</h2>

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

          <div className="grid gap-4 lg:grid-cols-2">
            <JsonEditor value={plan} onValidChange={setPlan} />
            <div className="space-y-4">
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

              <Card className="space-y-3">
                <Button
                  variant="primary"
                  className="w-full"
                  icon={<Play className="size-4" aria-hidden />}
                  loading={creating}
                  onClick={() => void handleGenerateAll()}
                >
                  Generar todo
                </Button>
                {createError && (
                  <p
                    role="alert"
                    className="rounded-sm bg-danger/10 p-2 text-label text-danger"
                  >
                    {createError}
                  </p>
                )}
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
                  Todo se guarda en{" "}
                  <code className="code text-fg">output/&lt;project_id&gt;/</code>.
                </p>
              </Card>
            </div>
          </div>
        </section>
      )}

      {/* ──────────────────── 5: proyectos recientes ──────────────────── */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-title font-semibold text-fg">Proyectos de video</h2>
          {cargaLista === "listo" && projects.length > 0 && (
            <p className="text-label text-fg-dim">
              <span className="code tnum text-fg">{projects.length}</span> en total
            </p>
          )}
        </div>

        {deleteError && (
          <p role="alert" className="rounded-sm bg-danger/10 p-2 text-body text-danger">
            {deleteError}
          </p>
        )}

        {cargaLista === "cargando" ? (
          // Esqueleto con la forma de la grilla, no un spinner: cuando llega la lista
          // real no se mueve nada de lugar.
          <ul
            aria-busy
            aria-label="Cargando proyectos"
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          >
            {Array.from({ length: 6 }, (_, i) => (
              <li key={i} className="space-y-2 rounded-lg bg-surface p-4">
                <div className="flex items-start justify-between gap-2">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-4 w-16" />
                </div>
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-3 w-1/3" />
              </li>
            ))}
          </ul>
        ) : cargaLista === "error" ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-danger/10 p-3">
            <p role="alert" className="text-body text-danger">
              No se pudo leer la lista de proyectos. Los que ya existen siguen ahí.
            </p>
            <Button size="sm" onClick={() => void loadProjects()}>
              Reintentar
            </Button>
          </div>
        ) : projects.length === 0 ? (
          <EmptyState
            icon={<FilmSlate className="size-6" aria-hidden />}
            title="Todavía no hay ningún proyecto de video"
            body="Pegá un brief arriba y dale a Interpretar con IA, o pegá un PlanJSON si ya lo tenés armado. El proyecto se crea recién cuando apretás Generar todo. Las tandas de imágenes sueltas viven en la pantalla Imágenes, no acá."
            action={{
              label: "Cargar un brief de ejemplo",
              onClick: () => {
                setMode("ia");
                setBrief(SAMPLE_BRIEF);
              },
            }}
          />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <li key={p.id}>
                <Card className="flex h-full flex-col gap-3">
                  <div className="flex items-start justify-between gap-2">
                    <Link
                      href={`/project/${p.id}/pipeline`}
                      className="min-w-0 rounded-sm text-body font-medium text-fg transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      <span className="block truncate">{p.name || p.id}</span>
                    </Link>
                    <span className="shrink-0">
                      <StatusBadge status={p.status} />
                    </span>
                  </div>

                  <dl className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-label text-fg-dim">
                    <div className="flex items-baseline gap-1">
                      <dt className="sr-only">Imágenes</dt>
                      <dd>
                        <span className="code tnum text-fg">{p.imageCount}</span>{" "}
                        imágenes
                      </dd>
                    </div>
                    <div className="flex items-baseline gap-1">
                      <dt className="sr-only">Clips</dt>
                      <dd>
                        <span className="code tnum text-fg">{p.clipCount}</span> clips
                      </dd>
                    </div>
                  </dl>

                  <div className="mt-auto flex items-center justify-between gap-2 border-t border-divider pt-3">
                    <p className="code tnum min-w-0 truncate text-label text-fg-dim">
                      {new Date(p.createdAt).toLocaleString()}
                    </p>
                    <Button
                      size="sm"
                      variant="danger"
                      icon={<Trash className="size-3.5" aria-hidden />}
                      loading={deletingId === p.id}
                      onClick={() => setABorrar(p)}
                      title="Borrar el proyecto y TODOS sus archivos (imágenes y videos)"
                    >
                      Borrar
                    </Button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/*
        Confirmacion de borrado. Reemplaza al window.confirm, que en una app oscura
        aparece como un cuadro del sistema operativo y se acepta por reflejo. El
        detalle es el mismo que decia antes: cuantos archivos se pierden y que no
        se puede deshacer.
      */}
      {aBorrar && (
        <Confirmar
          abierto
          onCambio={(v) => {
            if (!v) setABorrar(null);
          }}
          title={`¿Borrar "${aBorrar.name || aBorrar.id}"?`}
          detalle={
            `Se eliminan también los archivos generados: ${aBorrar.imageCount} imágenes y ` +
            `${aBorrar.clipCount} clips (la carpeta output/${aBorrar.id}/ entera). ` +
            `Esto no se puede deshacer.`
          }
          labelConfirmar="Borrar todo"
          peligroso
          onConfirmar={() => void handleDeleteProject(aBorrar)}
        />
      )}
    </div>
  );
}

/**
 * Un `<input type="file">` con forma de boton.
 *
 * El input va `sr-only` y NO `hidden`: oculto con `hidden` no se puede enfocar, y el
 * boton de subir archivo quedaba inalcanzable con teclado (era asi en las tres
 * apariciones de esta pantalla). Con `sr-only` el input sigue en el orden de
 * tabulacion, el label le presta la pinta, y `focus-within` dibuja el anillo.
 *
 * Los estilos salen del `Button` de T01 via `asChild`, para no volver a escribir a
 * mano la cadena de clases que el modulo entero quiere dejar de repetir.
 */
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

      {/* Nombre editable del proyecto (default: nombre del archivo). */}
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
      {item.createError && (
        <p className="text-label text-danger">{item.createError}</p>
      )}
    </li>
  );
}
