/**
 * Tandas SECUENCIALES del generador masivo de variaciones (/imagenes, pestaña
 * "Generador masivo").
 *
 * ─── POR QUE SECUENCIAL Y NO enqueueProject() DE LAS N DE UNA ────────────────
 *
 * `/api/imagenes/masivo` crea UN proyecto de imagenes por foto subida (mismo
 * mecanismo que `/api/imagenes` con imagen base: image2image contra esa foto). Si los
 * N proyectos se encolaran todos juntos con `enqueueProject()`, la cola global los
 * mezcla y corre `PIPELINE_CONCURRENCY` jobs en paralelo SIN importar de que proyecto
 * son. Con 10 fotos x variantes, eso son decenas de requests al mismo par de modelos
 * en la misma ventana de tiempo: exactamente el 429 en cascada que motivo este modulo
 * ("empiezan a fallar despues de los 10 reintentos").
 *
 * La mitigacion tiene DOS partes, y esta es solo la mitad "cuando":
 *   1. Alternar modelo Pro/Flash por proyecto (la otra mitad, en el route handler):
 *      cada proyecto pega contra una cuota DISTINTA, asi que dos proyectos corriendo
 *      a la vez no compiten por el mismo limite por minuto.
 *   2. ESTE modulo: un proyecto de la tanda no arranca hasta que el anterior termino
 *      (done/partial/failed). Con auto-aprobacion prendida (la tanda masiva la fuerza
 *      a `true`) un proyecto de imagenes corre solo, sin esperar a nadie, asi que
 *      "termino" es una condicion real y no un estado que dependa del usuario.
 *
 * ─── COMO SE ENGANCHA CON queue.ts SIN CREAR UN IMPORT CICLICO ───────────────
 *
 * Este modulo NO importa `queue.ts`: si lo hiciera, `queue.ts` -> `masivo.ts` ->
 * `queue.ts` seria un ciclo (queue.ts necesita llamar a `notifyProjectFinished` desde
 * `finalizeProjects`), y en un ciclo de ES modules el segundo import ve al primer
 * modulo solo parcialmente inicializado. En cambio, `enqueueProject` se RECIBE como
 * parametro (inyeccion de dependencia): lo pasa quien orquesta (el route handler de
 * `/api/imagenes/masivo`, que ya importa `queue.ts` para encolar el primer proyecto
 * de todos modos) y `notifyProjectFinished` lo recibe de la misma forma desde
 * `queue.ts`. Este archivo termina sin ningun import de `./queue`.
 *
 * Singleton en `globalThis`, mismo patron que `queue.ts`, para sobrevivir al HMR de
 * Next en dev y para que un reinicio no deje una tanda "colgada" en memoria vieja.
 */
import type { ProjectRecord } from "../types";
import { projectsDb } from "../db";

export interface BatchInfo {
  batchId: string;
  /** ids de proyecto en el ORDEN en que se crearon (y se van a correr). */
  projectIds: string[];
  /** indice (0-based) del proyecto que esta corriendo o va a correr a continuacion. */
  cursor: number;
  createdAt: string;
}

interface MasivoState {
  /** Tandas activas, por batchId. Se borran cuando el ultimo proyecto termina. */
  batches: Map<string, BatchInfo>;
  /** projectId -> batchId, para resolver "a que tanda pertenece este proyecto" en
   *  O(1) desde el hook de finalizeProjects sin recorrer todas las tandas. */
  byProject: Map<string, string>;
}

const globalForMasivo = globalThis as unknown as { __augcMasivo?: MasivoState };
const state: MasivoState =
  globalForMasivo.__augcMasivo ??
  (globalForMasivo.__augcMasivo = { batches: new Map(), byProject: new Map() });

/** Firma de `enqueueProject` de `queue.ts`, inyectada para evitar el ciclo de import. */
type EnqueueFn = (projectId: string) => void;

/**
 * Arranca una tanda secuencial: encola SOLO el primer proyecto. Los demas quedan en
 * `draft` (ya existen en la DB, con sus jobs armados por `buildJobs`, pero la cola
 * nunca los toca hasta que les llegue el turno).
 *
 * `projectIds` ya viene en el orden que se quiere correr (el mismo en que se subieron
 * las fotos). Requiere al menos un id; con la lista vacia no hace nada.
 */
export function startBatch(
  batchId: string,
  projectIds: string[],
  enqueueProject: EnqueueFn
): void {
  if (projectIds.length === 0) return;
  state.batches.set(batchId, {
    batchId,
    projectIds,
    cursor: 0,
    createdAt: new Date().toISOString(),
  });
  for (const id of projectIds) state.byProject.set(id, batchId);
  enqueueProject(projectIds[0]);
}

/**
 * Se llama desde `queue.ts` (`finalizeProjects`) cada vez que un proyecto llega a un
 * status terminal (done/partial/failed). Si ese proyecto es el que esta al frente de
 * una tanda activa, encola el siguiente. Si no pertenece a ninguna tanda (el caso
 * normal, proyectos sueltos de siempre), no hace nada: la lookup por `byProject` es
 * O(1) para que este hook no le agregue costo perceptible al camino comun.
 */
export function notifyProjectFinished(
  projectId: string,
  enqueueProject: EnqueueFn
): void {
  const batchId = state.byProject.get(projectId);
  if (!batchId) return;
  const batch = state.batches.get(batchId);
  if (!batch) {
    state.byProject.delete(projectId);
    return;
  }

  const idx = batch.projectIds.indexOf(projectId);
  // Solo actua si el que termino es el que estaba al frente. Si terminara uno que ya
  // no es el actual (no deberia pasar: los siguientes ni se encolan), no reordena nada.
  if (idx !== batch.cursor) return;

  const next = batch.cursor + 1;
  if (next >= batch.projectIds.length) {
    // Tanda completa: se desarma el estado, no queda nada que limpiar despues.
    for (const id of batch.projectIds) state.byProject.delete(id);
    state.batches.delete(batchId);
    return;
  }

  batch.cursor = next;
  enqueueProject(batch.projectIds[next]);
}

/** Info de la tanda de un proyecto, o null si no pertenece a ninguna tanda ACTIVA. */
export function batchOf(projectId: string): BatchInfo | null {
  const batchId = state.byProject.get(projectId);
  if (!batchId) return null;
  return state.batches.get(batchId) ?? null;
}

/**
 * Snapshot de progreso de una tanda para la UI: cuantos proyectos terminaron, cual
 * esta corriendo, y el status de cada uno.
 *
 * No depende de que la tanda siga "activa" en `state.batches`: una tanda ya
 * COMPLETADA se borra de ahi en `notifyProjectFinished`, pero el progreso final
 * (todos done/partial/failed) tiene que poder seguir mostrandose despues. Por eso
 * este snapshot NO es la fuente de la verdad de los datos de cada proyecto (esos
 * salen de `projectsDb` en vivo) — es solo el ORDEN y el cursor, que necesitan
 * persistir mas alla de la vida de la tanda en memoria.
 */
export interface BatchProjectSummary {
  id: string;
  name: string;
  status: ProjectRecord["status"];
  position: number;
}

export function batchSummary(batchId: string): {
  batchId: string;
  cursor: number;
  projects: BatchProjectSummary[];
} | null {
  const batch = state.batches.get(batchId);
  if (!batch) return null;
  const projects = batch.projectIds.map((id, position) => {
    const p = projectsDb.get(id);
    return {
      id,
      name: p?.name ?? id,
      status: p?.status ?? "draft",
      position,
    };
  });
  return { batchId, cursor: batch.cursor, projects };
}
