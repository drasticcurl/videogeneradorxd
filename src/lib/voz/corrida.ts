/**
 * La corrida del cambio de voz: cola, ciclo de vida de una version y reconciliacion tras
 * reinicio. Contrato de tasks/cambio-de-voz/02-DISENO.md §10.
 *
 * Cola PROPIA y en memoria, no queue.ts (D11): esa cola tiene fases, lotes, rate limit
 * de Veo y retoma tras reinicio, y nada de eso aplica aca. Una conversion a la vez en
 * TODA la app: ElevenLabs limita concurrencia por plan (Free 2) y la VPS comparte CPU
 * con los funnels.
 *
 * El proveedor llega POR PARAMETRO (§3): este archivo no importa voz/index.ts. Lo arma
 * la ruta, que sabe que usuario pidio, con el mismo patron con el que masivo.ts recibe
 * enqueueProject. Si se "simplifica" importando el factory, se ata el motor a la config.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import { jobsDb, projectsDb } from "../db";
import { logEvent } from "../jobs/pipeline";
import { absPathFor, projectDir, slugify } from "../storage";
import type { AjustesDeVoz, RecetaUnido, VersionDeVoz } from "../types";
import { estadoDelUnido, recetaVigente } from "../unido";
import {
  DuracionInesperada,
  concatenar,
  cortarTramo,
  extraerCompleto,
  hayFfmpegYFfprobe,
  muestra,
  normalizarSalida,
  piezaConservada,
  recortePrueba,
  remux,
} from "./audio";
import { BOOT_ID, corridaVivaDe } from "./estado";
import { ErrorDeVoz, type VozProvider } from "./tipos";
import { armarPiezas, estimar, ventanaDePrueba, type Pieza } from "./tramos";

export interface OpcionesDeCorrida {
  voz: { id: string; nombre: string };
  ajustes: AjustesDeVoz | null;
  quitarRuido: boolean;
  incluirFilmados: boolean;
  prueba: boolean;
}

export type CodigoErrorDeCorrida =
  | "sin_unido" | "sin_receta" | "desactualizado" | "ocupado" | "nada_para_convertir" | "sin_ffmpeg";

/** Validacion de entrada de iniciarCorrida. La ruta la traduce a 400 (o 409 si "ocupado"). */
export class ErrorDeCorrida extends Error {
  codigo: CodigoErrorDeCorrida;
  constructor(message: string, codigo: CodigoErrorDeCorrida) {
    super(message);
    this.name = "ErrorDeCorrida";
    this.codigo = codigo;
  }
}

/* Mensajes de §14. */
const MSJ = {
  sinFfmpeg: "Falta ffmpeg o ffprobe en el server.",
  sinUnido: "Este proyecto todavía no tiene video unido.",
  sinReceta: "Este video se unió antes del cambio de voz. Volvé a unir una vez para habilitarlo.",
  ocupado: "Ya hay un cambio de voz en curso en este proyecto.",
  nada: "No hay clips con diálogo para convertir.",
  nadaFilmados: " Probá incluir los clips filmados.",
  unidoCambio: "El video unido cambió mientras se convertía.",
  reinicio: "El server se reinició mientras se convertía. Volvé a intentarlo.",
  duracion: (n: number) => `ElevenLabs devolvió un audio de duración inesperada (tramo ${n}).`,
  limite: "ElevenLabs está saturado. Probá de nuevo en unos minutos.",
};

const REINTENTOS = 4;

/* ─────────────────────────── estado de la cola ─────────────────────────── */

interface Tarea {
  projectId: string;
  versionId: string;
  proveedor: VozProvider;
  opciones: OpcionesDeCorrida;
}

interface EstadoCola {
  cola: Tarea[];
  actual: { projectId: string; versionId: string; ctrl: AbortController } | null;
}

// Singleton en globalThis, como queue.ts y masivo.ts: sobrevive al HMR de dev.
const globalForCorrida = globalThis as unknown as { __augcVozCorrida?: EstadoCola };
const estado: EstadoCola =
  globalForCorrida.__augcVozCorrida ?? (globalForCorrida.__augcVozCorrida = { cola: [], actual: null });

/** El proyecto se borro a mitad: la corrida se corta sin escribir nada (D18). */
class ProyectoBorrado extends Error {
  constructor() {
    super("El proyecto ya no existe.");
    this.name = "ProyectoBorrado";
  }
}

/* ─────────────────────────── persistencia ─────────────────────────── */

/**
 * Leer y despues escribir, SIEMPRE (regla 3): relee el proyecto y reescribe solo
 * `versionesVoz`. Nunca se guarda una copia vieja del ProjectRecord: la cola de Vertex
 * tambien lo actualiza (status), y pisarlo con una copia vieja le borra cambios.
 *
 * Una version ya "cancelada" no se toca mas: el ciclo de la corrida puede venir detras
 * (un tramo que termina justo despues del cancelar) y no tiene que revivirla.
 */
function actualizarVersion(projectId: string, versionId: string, patch: Partial<VersionDeVoz>): VersionDeVoz {
  const project = projectsDb.get(projectId);
  if (!project) throw new ProyectoBorrado();
  const versiones = project.versionesVoz ?? [];
  const i = versiones.findIndex((v) => v.id === versionId);
  if (i < 0) throw new ProyectoBorrado();
  if (versiones[i].estado === "cancelada" && patch.estado !== "cancelada") return versiones[i];
  const nueva: VersionDeVoz = { ...versiones[i], ...patch, actualizadoEn: new Date().toISOString() };
  const todas = versiones.slice();
  todas[i] = nueva;
  projectsDb.update(projectId, { versionesVoz: todas });
  return nueva;
}

/* ─────────────────────────── contrato ─────────────────────────── */

function piezasPara(receta: RecetaUnido, o: OpcionesDeCorrida): { piezas: Pieza[]; ventana: { inicioSeg: number; finSeg: number } | null } {
  const maxSeg = config.voz.tramoMaxSeg;
  if (!o.prueba) return { piezas: armarPiezas(receta, { incluirFilmados: o.incluirFilmados, maxSeg }), ventana: null };
  const ventana = ventanaDePrueba(receta, { incluirFilmados: o.incluirFilmados, pruebaSeg: config.voz.pruebaSeg });
  if (!ventana) return { piezas: [], ventana: null };
  return { piezas: armarPiezas(receta, { incluirFilmados: o.incluirFilmados, maxSeg, ventana }), ventana };
}

/** Valida SINCRONICO (lanza ErrorDeCorrida), persiste la version "en_cola" y la encola. */
export function iniciarCorrida(args: {
  projectId: string;
  usuario: string;
  opciones: OpcionesDeCorrida;
  proveedor: VozProvider;          // inyectado por la ruta (§3)
}): VersionDeVoz {
  const { projectId, usuario, opciones, proveedor } = args;

  // Regla 1, en este orden.
  if (!hayFfmpegYFfprobe()) throw new ErrorDeCorrida(MSJ.sinFfmpeg, "sin_ffmpeg");
  const project = projectsDb.get(projectId);
  if (!project) throw new ErrorDeCorrida(MSJ.sinUnido, "sin_unido");
  const jobs = jobsDb.byProject(projectId);
  const unido = estadoDelUnido(project, jobs);
  if (!unido.existe) throw new ErrorDeCorrida(MSJ.sinUnido, "sin_unido");
  if (!unido.conReceta) throw new ErrorDeCorrida(MSJ.sinReceta, "sin_receta");
  if (unido.desactualizado) {
    throw new ErrorDeCorrida(`${unido.motivo} Volvé a unir antes de cambiar la voz.`, "desactualizado");
  }
  if (corridaVivaDe(project)) throw new ErrorDeCorrida(MSJ.ocupado, "ocupado");
  const receta = recetaVigente(project, jobs)!;

  const { piezas } = piezasPara(receta, opciones);
  const tramosTotal = piezas.filter((p) => p.tipo === "convertir").length;
  if (tramosTotal === 0) {
    const hayFilmados = receta.clips.some((c) => c.etiqueta === "FILMAR_REAL" && c.conDialogo);
    throw new ErrorDeCorrida(
      MSJ.nada + (hayFilmados && !opciones.incluirFilmados ? MSJ.nadaFilmados : ""),
      "nada_para_convertir",
    );
  }

  const ahora = new Date().toISOString();
  const version: VersionDeVoz = {
    id: randomUUID(),
    voz: { id: opciones.voz.id, nombre: opciones.voz.nombre },
    proveedor: proveedor.nombre,
    modelo: null,
    ajustes: opciones.ajustes,
    quitarRuido: opciones.quitarRuido,
    incluirFilmados: opciones.incluirFilmados,
    prueba: opciones.prueba,
    estado: "en_cola",
    progreso: { tramosListos: 0, tramosTotal },
    segundosConvertidos: 0,
    file: null,
    bytes: null,
    error: null,
    recetaCreadaEn: receta.creadoEn,
    bootId: BOOT_ID,
    usuario,
    creadoEn: ahora,
    actualizadoEn: ahora,
  };
  // La mas nueva PRIMERO. Releido recien arriba, en el mismo tick: no hay copia vieja.
  projectsDb.update(projectId, { versionesVoz: [version, ...(project.versionesVoz ?? [])] });

  estado.cola.push({ projectId, versionId: version.id, proveedor, opciones });
  void siguiente();
  return version;
}

/** true si habia una viva para ese proyecto (en cola o procesando). Idempotente. */
export function cancelarCorrida(projectId: string): boolean {
  let habia = false;

  const enCola = estado.cola.filter((t) => t.projectId === projectId);
  if (enCola.length > 0) {
    estado.cola = estado.cola.filter((t) => t.projectId !== projectId);
    for (const t of enCola) marcarCancelada(t.projectId, t.versionId);
    habia = true;
  }

  const a = estado.actual;
  if (a && a.projectId === projectId && !a.ctrl.signal.aborted) {
    // Corta el fetch y mata el ffmpeg en curso; el finally de procesar borra el trabajo.
    a.ctrl.abort();
    marcarCancelada(a.projectId, a.versionId);
    habia = true;
  }
  return habia;
}

function marcarCancelada(projectId: string, versionId: string): void {
  try {
    const v = actualizarVersion(projectId, versionId, { estado: "cancelada", error: null });
    logEvent(projectId, "warn", `Voz: se canceló el cambio a ${v.voz.nombre}`);
  } catch {
    // El proyecto ya no esta: nada que marcar.
  }
}

let reconciliado = false;

/**
 * Una vez por proceso: marca "fallida" las versiones huerfanas (D12) y borra sus
 * voz/_trabajo/. NO se retoman: retomar gastaria creditos de un trabajo que nadie esta
 * mirando. Se reintenta con un clic.
 *
 * Lo llaman las rutas de /voz al entrar, NO el modulo al cargarse: Next evalua modulos
 * durante el build, y un `next build` no tiene que tocar la base de produccion (el mismo
 * motivo que recuperarTrasReinicio en queue.ts).
 */
export function reconciliarTrasReinicio(): void {
  if (reconciliado) return;
  reconciliado = true;
  for (const project of projectsDb.list()) {
    const huerfanas = (project.versionesVoz ?? []).filter(
      (v) => (v.estado === "en_cola" || v.estado === "procesando") && v.bootId !== BOOT_ID,
    );
    if (huerfanas.length === 0) continue;
    for (const v of huerfanas) {
      try {
        actualizarVersion(project.id, v.id, { estado: "fallida", error: MSJ.reinicio });
        logEvent(project.id, "error", `Voz: ${MSJ.reinicio}`);
      } catch {
        /* proyecto borrado entre medio */
      }
    }
    void fsp.rm(path.join(projectDir(project.id), "voz", "_trabajo"), { recursive: true, force: true });
  }
}

/* ─────────────────────────── el proceso ─────────────────────────── */

async function siguiente(): Promise<void> {
  if (estado.actual) return;
  const tarea = estado.cola.shift();
  if (!tarea) return;
  const ctrl = new AbortController();
  estado.actual = { projectId: tarea.projectId, versionId: tarea.versionId, ctrl };
  try {
    await procesar(tarea, ctrl.signal);
  } finally {
    estado.actual = null;
    void siguiente();
  }
}

function esperar(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const e = new Error("Cancelado");
  e.name = "AbortError";
  return e;
}

/** Regla 5: hasta 4 reintentos para ErrorDeVoz.reintentable; lo demas corta al toque. */
async function convertirConReintentos(
  t: Tarea,
  wav: Uint8Array,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; extension: "mp3" | "wav"; modelo: string }> {
  for (let intento = 0; ; intento++) {
    try {
      return await t.proveedor.convertir({
        voiceId: t.opciones.voz.id,
        wav,
        ajustes: t.opciones.ajustes,
        quitarRuido: t.opciones.quitarRuido,
        signal,
      });
    } catch (err) {
      if (!(err instanceof ErrorDeVoz) || !err.reintentable || intento >= REINTENTOS) throw err;
      const base = err.retryAfterMs ?? Math.min(60_000, 5_000 * 2 ** intento);
      await esperar(base + Math.floor(Math.random() * 1000), signal);
    }
  }
}

/** Existe el proyecto (D18). Se chequea antes de cada escritura en su carpeta. */
function asegurarProyecto(projectId: string): void {
  if (!projectsDb.get(projectId)) throw new ProyectoBorrado();
}

async function procesar(t: Tarea, signal: AbortSignal): Promise<void> {
  const { projectId, versionId, opciones } = t;
  const trabajo = path.join(projectDir(projectId), "voz", "_trabajo", versionId);
  let nombreVoz = opciones.voz.nombre;

  try {
    const v0 = actualizarVersion(projectId, versionId, { estado: "procesando" });
    if (v0.estado !== "procesando") return; // se cancelo mientras esperaba
    nombreVoz = v0.voz.nombre;

    const project = projectsDb.get(projectId);
    if (!project) throw new ProyectoBorrado();
    const receta = recetaVigente(project, jobsDb.byProject(projectId));
    if (!receta || receta.creadoEn !== v0.recetaCreadaEn) throw new Error(MSJ.unidoCambio);
    const unidoAbs = absPathFor(projectId, receta.file);
    const mtimeInicial = fs.statSync(unidoAbs).mtimeMs;

    const { piezas, ventana } = piezasPara(receta, opciones);
    const aConvertir = piezas.filter((p) => p.tipo === "convertir");
    const est = estimar(piezas, {
      facturacion: config.voz.facturacion,
      precioPorMinUsd: config.voz.precioPorMinUsd,
      duracionTotalSeg: receta.duracionSeg,
    });
    logEvent(
      projectId,
      "info",
      `Voz: convirtiendo a ${nombreVoz} (${aConvertir.length} tramos, ${Math.round(est.segundos)}s)`,
    );

    asegurarProyecto(projectId);
    if (signal.aborted) throw abortError();
    await fsp.mkdir(trabajo, { recursive: true });

    // Paso 1.
    const completo = path.join(trabajo, "completo.wav");
    const nTotal = await extraerCompleto(unidoAbs, completo, signal);

    // Fronteras por muestra. La ultima pieza de la completa va hasta N_total (absorbe el
    // relleno del AAC); en la prueba, hasta el fin de la ventana.
    const fronteras = piezas.map((p) => ({
      a: Math.min(muestra(p.inicioSeg), nTotal),
      b: p.finSeg === null ? nTotal : Math.min(muestra(p.finSeg), nTotal),
    }));

    const archivos: string[] = [];
    let listos = 0;
    let modelo: string | null = null;
    for (let i = 0; i < piezas.length; i++) {
      const p = piezas[i];
      const { a, b } = fronteras[i];
      const pieza = path.join(trabajo, `pieza_${i}.wav`);
      asegurarProyecto(projectId);

      if (p.tipo === "conservar") {
        // Paso 4. b null solo si es la ultima de la completa: hasta el final real.
        await piezaConservada(completo, a, p.finSeg === null ? null : b, pieza, signal);
      } else {
        // Paso 2 → proveedor → paso 3.
        const tramoIn = path.join(trabajo, `tramo_${i}_in.wav`);
        await cortarTramo(completo, a, b, tramoIn, signal);
        const r = await convertirConReintentos(t, new Uint8Array(await fsp.readFile(tramoIn)), signal);
        modelo = r.modelo;
        asegurarProyecto(projectId);
        const tramoOut = path.join(trabajo, `tramo_${i}_out.${r.extension}`);
        await fsp.writeFile(tramoOut, r.bytes);
        try {
          await normalizarSalida(tramoOut, b - a, pieza, { offsetMs: config.voz.offsetMs, trabajo, signal });
        } catch (err) {
          if (err instanceof DuracionInesperada) throw new Error(MSJ.duracion(listos + 1));
          throw err;
        }
        listos += 1;
        actualizarVersion(projectId, versionId, {
          progreso: { tramosListos: listos, tramosTotal: aConvertir.length },
          modelo,
        });
      }
      archivos.push(pieza);
    }

    // Paso 5: la pista nueva mide exactamente lo que tiene que medir.
    const esperadas = ventana ? fronteras[fronteras.length - 1].b - fronteras[0].a : nTotal;
    const nuevo = path.join(trabajo, "nuevo.wav");
    await concatenar(archivos, nuevo, esperadas, trabajo, signal);

    // Regla 7: el unido no cambio mientras se convertia (D17, defensa en profundidad).
    const p2 = projectsDb.get(projectId);
    if (!p2) throw new ProyectoBorrado();
    const r2 = recetaVigente(p2, jobsDb.byProject(projectId));
    let mtimeFinal: number | null = null;
    try {
      mtimeFinal = fs.statSync(unidoAbs).mtimeMs;
    } catch {
      mtimeFinal = null;
    }
    if (!r2 || r2.creadoEn !== receta.creadoEn || mtimeFinal !== mtimeInicial) throw new Error(MSJ.unidoCambio);

    // Pasos 6 / 7 a .tmp.mp4 y rename (D21): nunca queda un archivo cortado con nombre
    // de version lista que la UI ofrezca descargar.
    const slugProyecto = slugify(p2.name || p2.id);
    const slugVoz = slugify(nombreVoz);
    const id6 = versionId.slice(0, 6);
    const rel = opciones.prueba
      ? `voz/${slugProyecto}__prueba-voz-${slugVoz}-${id6}.mp4`
      : `voz/${slugProyecto}__voz-${slugVoz}-${id6}.mp4`;
    const abs = absPathFor(projectId, rel);
    const tmp = abs.replace(/\.mp4$/, ".tmp.mp4");
    asegurarProyecto(projectId);
    if (signal.aborted) throw abortError();
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    if (ventana) {
      await recortePrueba(unidoAbs, nuevo, ventana.inicioSeg, ventana.finSeg - ventana.inicioSeg, tmp, signal);
    } else {
      await remux(unidoAbs, nuevo, tmp, signal);
    }
    asegurarProyecto(projectId);
    await fsp.rename(tmp, abs);
    const bytes = (await fsp.stat(abs)).size;

    actualizarVersion(projectId, versionId, {
      estado: "lista",
      file: rel,
      bytes,
      segundosConvertidos: est.segundos,
      error: null,
    });
    logEvent(projectId, "success", `Voz lista: ${rel}`);
  } catch (err) {
    // Cancelado o proyecto borrado: no es una falla y no se escribe nada (D18).
    if (signal.aborted || err instanceof ProyectoBorrado || (err instanceof Error && err.name === "AbortError")) {
      return;
    }
    const mensaje =
      err instanceof ErrorDeVoz && err.codigo === "limite"
        ? MSJ.limite
        : err instanceof Error
          ? err.message
          : String(err);
    try {
      actualizarVersion(projectId, versionId, { estado: "fallida", error: mensaje });
      logEvent(projectId, "error", `Voz: ${mensaje}`);
    } catch {
      /* proyecto borrado entre medio */
    }
  } finally {
    await fsp.rm(trabajo, { recursive: true, force: true });
    // _trabajo/ vacio tampoco queda (rmdir falla solo si otra corrida lo esta usando).
    await fsp.rmdir(path.dirname(trabajo)).catch(() => {});
    // Los .tmp.mp4 de una corrida cortada tampoco quedan.
    const vozDir = path.join(projectDir(projectId), "voz");
    try {
      for (const f of await fsp.readdir(vozDir)) {
        if (f.endsWith(".tmp.mp4") && f.includes(versionId.slice(0, 6))) await fsp.rm(path.join(vozDir, f), { force: true });
      }
    } catch {
      /* no hay carpeta voz: nada que limpiar */
    }
  }
}
