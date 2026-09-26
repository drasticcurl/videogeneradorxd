"use client";

/**
 * "Tu cuenta de Vertex": cada usuario ve con que cuenta genera, carga la suya y aprende
 * a sacarla. Se abre desde el nombre, arriba a la derecha (SessionBar).
 *
 * Se escribe contra el contrato HTTP de /api/cuenta-vertex y solo importa TIPOS de
 * @/lib/types: nada de @/lib/cuentaVertex, que trae node:fs y las llaves.
 *
 * ─── DECISIONES QUE PARECEN DETALLES ─────────────────────────────────────────
 *
 * 1. El JSON se lee en el navegador SOLO para mostrar que se eligio (tipo, email) y
 *    completar el proyecto. La validacion de verdad la hace el server, que es el unico
 *    que no se puede saltear.
 * 2. "Probar y guardar" es un solo boton a proposito: el server prueba la cuenta contra
 *    Google (gratis) y la guarda SOLO si anda. Una cuenta rota guardada deja los jobs
 *    en rojo sin que nadie sepa por que.
 * 3. Los botones usan `loading` y NO cambian el texto (§5 del rediseño).
 * 4. El archivo se copia del input ANTES de limpiarlo: `e.target.files` es una lista
 *    viva y el `value = ""` la vacia (el mismo bug que tuvo el generador masivo).
 */

import {
  ArrowSquareOut,
  CaretDown,
  CaretRight,
  CheckCircle,
  FileText,
  Info,
  PlugsConnected,
  Trash,
  UploadSimple,
  WarningCircle,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

import { Badge, Button, Confirmar, Dialog, DialogContent, Input } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { EstadoCuentaVertex, PruebaCuentaVertex } from "@/lib/types";
import { estadoDeCuentaVertex } from "@/lib/ui-tokens";

const RUTA = "/api/cuenta-vertex";

interface Respuesta {
  estado: EstadoCuentaVertex;
  prueba?: PruebaCuentaVertex;
}

/** El archivo elegido, con lo que se pudo leer de el para mostrarlo. */
interface Elegido {
  nombre: string;
  texto: string;
  tipo: string | null;
  email: string | null;
}

type Resultado =
  | { tono: "ok"; texto: string }
  | { tono: "error"; texto: string; ayuda: { texto: string; url: string } | null };

async function llamar(metodo: "GET" | "POST" | "DELETE", body?: unknown): Promise<Respuesta> {
  const res = await fetch(RUTA, {
    method: metodo,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const datos = (await res.json().catch(() => null)) as (Respuesta & { error?: string }) | null;
  if (!res.ok || !datos?.estado) {
    throw new Error(
      datos?.error ??
        (res.status === 401 ? "Tu sesión venció. Volvé a entrar." : `El servidor contestó ${res.status}.`),
    );
  }
  return datos;
}

function fecha(iso: string): string {
  return new Date(iso).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/** Que dice el estado de la cuenta, en una frase. */
function explicacion(e: EstadoCuentaVertex): string {
  const p = e.proyecto ?? "";
  switch (e.origen) {
    case "app":
      return `Generás con tu cuenta: lo que generes se factura al proyecto ${p}.`;
    case "servidor":
      return `Generás con una cuenta propia que configuró el administrador en el servidor (proyecto ${p}). Si cargás una acá, se usa la tuya.`;
    case "compartida":
      return `Generás con la cuenta compartida (proyecto ${p}): lo que generes se le factura a esa cuenta. Cargá la tuya para que se te facture a vos.`;
    default:
      return "No tenés cuenta de Vertex y no hay una compartida: no vas a poder generar hasta cargar la tuya.";
  }
}

export default function CuentaVertexDialog({
  abierto,
  onCambio,
  estado,
  onEstado,
}: {
  abierto: boolean;
  onCambio: (v: boolean) => void;
  estado: EstadoCuentaVertex;
  onEstado: (e: EstadoCuentaVertex) => void;
}) {
  const [elegido, setElegido] = useState<Elegido | null>(null);
  const [proyecto, setProyecto] = useState("");
  const [errorArchivo, setErrorArchivo] = useState<string | null>(null);
  const [arrastrando, setArrastrando] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [probando, setProbando] = useState(false);
  const [quitando, setQuitando] = useState(false);
  const [confirmarQuitar, setConfirmarQuitar] = useState(false);
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [verTutorial, setVerTutorial] = useState(estado.origen !== "app");
  const refResultado = useRef<HTMLDivElement>(null);

  // El resultado aparece arriba de "Cargar tu cuenta", y "Probar y guardar" queda abajo:
  // con el dialogo scrolleado, el mensaje salia fuera de la vista y parecia que no paso nada.
  useEffect(() => {
    if (resultado) refResultado.current?.scrollIntoView({ block: "nearest" });
  }, [resultado]);

  // Al abrir: el estado fresco (pudo cambiar en otra pestaña) y nada de la vez anterior.
  useEffect(() => {
    if (!abierto) return;
    setElegido(null);
    setProyecto("");
    setErrorArchivo(null);
    setResultado(null);
    setVerTutorial(estado.origen !== "app");
    llamar("GET")
      .then((r) => onEstado(r.estado))
      .catch(() => {
        /* se queda con el que llego del server al cargar la pagina */
      });
    // Solo al abrir: `estado` y `onEstado` cambian justamente por este efecto.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abierto]);

  async function elegir(archivo: File) {
    setResultado(null);
    setErrorArchivo(null);
    const texto = await archivo.text();
    let tipo: string | null = null;
    let email: string | null = null;
    try {
      const j = JSON.parse(texto) as Record<string, unknown>;
      tipo = typeof j.type === "string" ? j.type : null;
      email = typeof j.client_email === "string" ? j.client_email : null;
      const delJson = j.project_id ?? j.quota_project_id;
      if (typeof delJson === "string" && delJson) setProyecto(delJson);
    } catch {
      setErrorArchivo("Ese archivo no es un JSON. Elegí el .json que descargaste de Google.");
    }
    setElegido({ nombre: archivo.name, texto, tipo, email });
  }

  async function guardar() {
    if (!elegido) return;
    setGuardando(true);
    setResultado(null);
    try {
      const r = await llamar("POST", { llave: elegido.texto, proyecto });
      onEstado(r.estado);
      if (r.prueba?.ok) {
        setElegido(null);
        setProyecto("");
        setVerTutorial(false);
        setResultado({
          tono: "ok",
          texto: `Listo: desde ahora generás con tu cuenta (proyecto ${r.estado.proyecto}). La prueba con Google salió bien.`,
        });
      } else if (r.prueba) {
        setResultado({ tono: "error", texto: `No se guardó. ${r.prueba.motivo}`, ayuda: r.prueba.ayuda });
      }
    } catch (err) {
      setResultado({ tono: "error", texto: err instanceof Error ? err.message : String(err), ayuda: null });
    } finally {
      setGuardando(false);
    }
  }

  async function probar() {
    setProbando(true);
    setResultado(null);
    try {
      const r = await llamar("POST", { probar: true });
      onEstado(r.estado);
      setResultado(
        r.prueba?.ok
          ? { tono: "ok", texto: `Anda: la cuenta puede generar en ${r.estado.proyecto}.` }
          : { tono: "error", texto: r.prueba?.motivo ?? "No se pudo probar.", ayuda: r.prueba?.ok === false ? r.prueba.ayuda : null },
      );
    } catch (err) {
      setResultado({ tono: "error", texto: err instanceof Error ? err.message : String(err), ayuda: null });
    } finally {
      setProbando(false);
    }
  }

  async function quitar() {
    setQuitando(true);
    setResultado(null);
    try {
      const r = await llamar("DELETE");
      onEstado(r.estado);
      setVerTutorial(true);
      setResultado({
        tono: "ok",
        texto:
          r.estado.origen === "ninguna"
            ? "Se quitó tu cuenta. No vas a poder generar hasta cargar otra."
            : `Se quitó tu cuenta. Volvés a la ${estadoDeCuentaVertex(r.estado.origen).label.toLowerCase()} (proyecto ${r.estado.proyecto}).`,
      });
    } catch (err) {
      setResultado({ tono: "error", texto: err instanceof Error ? err.message : String(err), ayuda: null });
    } finally {
      setQuitando(false);
    }
  }

  const visual = estadoDeCuentaVertex(estado.origen);

  return (
    <Dialog open={abierto} onOpenChange={onCambio}>
      <DialogContent
        title="Tu cuenta de Vertex"
        description="Con esta cuenta de Google Cloud se generan tus imágenes y videos, y a ella se le factura."
        className="w-[min(40rem,calc(100vw-2rem))] max-h-[calc(100vh-2rem)] overflow-y-auto"
      >
        <div className="flex flex-col gap-4">
          {estado.modo === "mock" && (
            <p className="flex items-start gap-2 rounded-sm bg-info/10 px-3 py-2 text-body text-info">
              <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
              La app está en modo de prueba (mock): no llama a Vertex y no gasta. Tu cuenta se va a
              usar cuando pase a modo vertex.
            </p>
          )}

          {/* ─── la cuenta de hoy ─── */}
          <section aria-labelledby="cuenta-ahora" className="flex flex-col gap-2 rounded-md border border-divider p-3">
            <div className="flex flex-wrap items-center gap-2">
              <h3 id="cuenta-ahora" className="sr-only">
                La cuenta que usás hoy
              </h3>
              <Badge tone={visual.tone} punto>
                {visual.label}
              </Badge>
              {estado.proyecto && <span className="font-mono text-label text-fg">{estado.proyecto}</span>}
            </div>
            <p className="text-body text-fg-dim">{explicacion(estado)}</p>
            {estado.origen === "app" && (
              <p className="text-label text-fg-dim">
                {estado.email ? (
                  <>
                    Cuenta de servicio <span className="font-mono text-fg">{estado.email}</span>
                  </>
                ) : (
                  "Login de gcloud"
                )}
                {estado.cargadaEn && <> · cargada el {fecha(estado.cargadaEn)}</>}
              </p>
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                type="button"
                size="sm"
                onClick={probar}
                loading={probando}
                disabled={estado.origen === "ninguna" || guardando || quitando}
                icon={<PlugsConnected aria-hidden className="size-3.5" />}
              >
                Probar conexión
              </Button>
              {estado.origen === "app" && (
                <Button
                  type="button"
                  size="sm"
                  variant="danger"
                  onClick={() => setConfirmarQuitar(true)}
                  loading={quitando}
                  disabled={guardando || probando}
                  icon={<Trash aria-hidden className="size-3.5" />}
                >
                  Quitar mi cuenta
                </Button>
              )}
            </div>
          </section>

          {/*
            ─── el resultado de la ultima accion ───
            Existe siempre (aria-live tiene que estar antes que el texto). Vacio, el
            `empty:-mt-4` le devuelve el gap de arriba: sin eso quedaba un hueco doble.
          */}
          <div ref={refResultado} aria-live="polite" className="empty:-mt-4">
            {resultado?.tono === "ok" && (
              <p role="status" className="flex items-start gap-2 rounded-sm bg-ok/10 px-3 py-2 text-body text-ok">
                <CheckCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
                {resultado.texto}
              </p>
            )}
            {resultado?.tono === "error" && (
              <div role="alert" className="flex items-start gap-2 rounded-sm bg-danger/10 px-3 py-2 text-body text-danger">
                <WarningCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
                <div className="flex flex-col gap-1">
                  <span>{resultado.texto}</span>
                  {resultado.ayuda && (
                    <a
                      href={resultado.ayuda.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 self-start rounded-sm font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      {resultado.ayuda.texto}
                      <ArrowSquareOut aria-hidden className="size-3.5" />
                    </a>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* ─── cargar ─── */}
          <section aria-labelledby="cuenta-cargar" className="flex flex-col gap-3">
            <h3 id="cuenta-cargar" className="text-body font-medium text-fg">
              {estado.origen === "app" ? "Reemplazar tu cuenta" : "Cargar tu cuenta"}
            </h3>
            <label
              onDragOver={(e) => {
                e.preventDefault();
                setArrastrando(true);
              }}
              onDragLeave={() => setArrastrando(false)}
              onDrop={(e) => {
                e.preventDefault();
                setArrastrando(false);
                const archivo = e.dataTransfer.files[0];
                if (archivo) void elegir(archivo);
              }}
              className={cn(
                "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed",
                "px-3 py-5 text-center text-body text-fg-dim transition-colors",
                "focus-within:ring-2 focus-within:ring-accent",
                arrastrando ? "border-accent bg-accent/5 text-fg" : "border-divider bg-surface hover:border-border",
              )}
            >
              {elegido ? (
                <>
                  <FileText aria-hidden className="size-5" />
                  <span className="font-mono text-fg">{elegido.nombre}</span>
                  <span className="text-label">
                    {elegido.tipo === "service_account"
                      ? `Cuenta de servicio ${elegido.email ?? ""}`
                      : elegido.tipo === "authorized_user"
                        ? "Login de gcloud"
                        : "Tipo desconocido"}
                    {" · "}hacé click para elegir otro
                  </span>
                </>
              ) : (
                <>
                  <UploadSimple aria-hidden className="size-5" />
                  Arrastrá el JSON de tu cuenta, o hacé click para elegirlo
                  <span className="text-label">El archivo .json que descargaste en el paso 4 del tutorial</span>
                </>
              )}
              <input
                type="file"
                accept="application/json,.json"
                onChange={(e) => {
                  // Copiar ANTES de limpiar: ver la decision 4 del encabezado.
                  const archivo = e.target.files?.[0];
                  e.target.value = "";
                  if (archivo) void elegir(archivo);
                }}
                className="sr-only"
              />
            </label>
            {errorArchivo && (
              <p role="alert" className="text-label text-danger">
                {errorArchivo}
              </p>
            )}
            <Input
              label="ID del proyecto"
              value={proyecto}
              onChange={(e) => setProyecto(e.target.value)}
              placeholder="mi-proyecto-123456"
              autoComplete="off"
              spellCheck={false}
              hint="Se completa solo si el JSON lo trae. Es el ID, no el nombre del proyecto."
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-label text-fg-dim">
                El JSON queda solo en el servidor. La app no lo vuelve a mostrar.
              </p>
              <Button
                type="button"
                variant="primary"
                onClick={guardar}
                loading={guardando}
                disabled={!elegido || !!errorArchivo || probando || quitando}
                icon={<CheckCircle aria-hidden className="size-4" />}
              >
                Probar y guardar
              </Button>
            </div>
          </section>

          {/* ─── tutorial ─── */}
          <section className="rounded-md border border-divider">
            <button
              type="button"
              onClick={() => setVerTutorial((x) => !x)}
              aria-expanded={verTutorial}
              aria-controls="cuenta-tutorial"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-body font-medium text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {verTutorial ? <CaretDown aria-hidden className="size-3.5" /> : <CaretRight aria-hidden className="size-3.5" />}
              Cómo conseguir tu JSON
              <span className="text-label font-normal text-fg-dim">unos 10 minutos, una sola vez</span>
            </button>
            {/*
              `hidden` como atributo Y como clase, igual que en CambiarVozDialog: el `flex`
              de la clase le gana al display:none del atributo.
            */}
            <div
              id="cuenta-tutorial"
              hidden={!verTutorial}
              className={cn("flex flex-col gap-3 border-t border-divider px-3 py-3 text-body text-fg-dim", !verTutorial && "hidden")}
            >
              <ol className="flex list-decimal flex-col gap-3 pl-5 marker:text-fg-dim">
                <li>
                  <span className="font-medium text-fg">Un proyecto con facturación.</span>{" "}
                  <Enlace url="https://console.cloud.google.com/projectcreate">Creá un proyecto</Enlace> en Google
                  Cloud y <Enlace url="https://console.cloud.google.com/billing/linkedaccount">vinculale una cuenta
                  de facturación</Enlace> (tu tarjeta). Anotá el <span className="text-fg">ID del proyecto</span>: aparece
                  abajo del nombre, algo como <code className="font-mono text-fg">mi-generador-123456</code>.
                </li>
                <li>
                  <span className="font-medium text-fg">Activá Vertex AI.</span> Con tu proyecto elegido arriba de todo en
                  la consola, abrí la <Enlace url="https://console.cloud.google.com/apis/library/aiplatform.googleapis.com">Vertex
                  AI API</Enlace> y tocá <span className="text-fg">Habilitar</span>.
                </li>
                <li>
                  <span className="font-medium text-fg">Creá una cuenta de servicio.</span> Es un usuario &ldquo;robot&rdquo;
                  que solo puede usar Vertex. En{" "}
                  <Enlace url="https://console.cloud.google.com/iam-admin/serviceaccounts/create">Cuentas de servicio →
                  Crear</Enlace> ponele de nombre <code className="font-mono text-fg">generador</code>, tocá{" "}
                  <span className="text-fg">Crear y continuar</span>, en Rol elegí{" "}
                  <span className="text-fg">Usuario de Vertex AI</span> y tocá <span className="text-fg">Listo</span>.
                </li>
                <li>
                  <span className="font-medium text-fg">Descargá la clave.</span> En la lista de cuentas de servicio entrá a
                  la que creaste → pestaña <span className="text-fg">Claves</span> →{" "}
                  <span className="text-fg">Agregar clave</span> → <span className="text-fg">Crear clave nueva</span> →{" "}
                  <span className="text-fg">JSON</span> → <span className="text-fg">Crear</span>. Se descarga un archivo{" "}
                  <code className="font-mono text-fg">.json</code>: ese es.
                </li>
                <li>
                  <span className="font-medium text-fg">Cargalo acá arriba</span> y tocá{" "}
                  <span className="text-fg">Probar y guardar</span>. Antes de guardarlo, la app hace una prueba gratis con
                  Google: si falta algo de los pasos anteriores, te dice qué y te lleva a donde se arregla.
                </li>
              </ol>

              <div className="flex flex-col gap-2 border-t border-divider pt-3">
                <p className="font-medium text-fg">Si algo no sale</p>
                <p>
                  <span className="text-fg">&ldquo;La creación de claves está inhabilitada&rdquo; en el paso 4:</span> tu
                  organización no deja crear claves. Usá tu login: instalá{" "}
                  <Enlace url="https://cloud.google.com/sdk/docs/install">gcloud</Enlace>, corré{" "}
                  <code className="font-mono text-fg">gcloud auth application-default login</code> y cargá el archivo que
                  se genera en <code className="font-mono text-fg">~/.config/gcloud/application_default_credentials.json</code>{" "}
                  (en Windows, <code className="font-mono text-fg">%APPDATA%\gcloud\application_default_credentials.json</code>).
                  Ese no trae el proyecto: escribí el ID a mano.
                </p>
                <p>
                  <span className="text-fg">Muchos &ldquo;Rate limit (429)&rdquo; al generar videos:</span> una cuenta nueva
                  arranca con poca cuota de Veo. Pedí más en{" "}
                  <Enlace url="https://console.cloud.google.com/iam-admin/quotas">Cuotas</Enlace>.
                </p>
                <p>
                  <span className="text-fg">Cuidá el JSON como una contraseña:</span> no lo mandes por chat ni por mail. Si se
                  filtra, borrá esa clave en la pestaña Claves de la cuenta de servicio y cargá una nueva acá.
                </p>
              </div>
            </div>
          </section>
        </div>

        <Confirmar
          abierto={confirmarQuitar}
          onCambio={setConfirmarQuitar}
          title="¿Quitar tu cuenta de Vertex?"
          detalle="Se borra tu llave del servidor. Desde ahí generás con la cuenta del servidor o la compartida, si hay; si no, no vas a poder generar hasta cargar otra."
          labelConfirmar="Quitar mi cuenta"
          peligroso
          onConfirmar={() => void quitar()}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Link a la consola de Google, en otra pestaña: el tutorial se sigue con el dialogo
 * abierto. `inline` y no `inline-flex`: un flex no se parte en dos renglones, y "vinculale
 * una cuenta de facturación" se salia del dialogo en un telefono.
 */
function Enlace({ url, children }: { url: string; children: React.ReactNode }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="rounded-sm text-accent underline underline-offset-2 hover:text-accent-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {children}
      <ArrowSquareOut aria-hidden className="ml-0.5 inline size-3 align-[-1px]" />
    </a>
  );
}
