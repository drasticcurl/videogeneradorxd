/**
 * ¿Hay una conversion de voz VIVA en este proceso? (D12 de tasks/cambio-de-voz/02-DISENO.md)
 *
 * Cada version guarda el `bootId` del proceso que la corre. Una version "en_cola" o
 * "procesando" con otro bootId es huerfana: el server se reinicio a mitad y nadie la
 * esta corriendo. Sin esta distincion, esa version bloquearia "Volver a unir" para
 * siempre (el stitch contesta 409 con una conversion viva, D17) y el proyecto quedaria
 * trabado sin que nadie pueda destrabarlo desde la UI.
 */
import { randomUUID } from "node:crypto";
import type { ProjectRecord, VersionDeVoz } from "../types";

/*
  Singleton en globalThis: sobrevive al HMR de dev (que re-evalua el modulo y, con un
  const suelto, cambiaria el id y dejaria huerfanas las corridas en curso) pero cambia
  con cada proceso, que es justo lo que tiene que detectar.
*/
const globalForVoz = globalThis as unknown as { __augcVozBootId?: string };

export const BOOT_ID: string = globalForVoz.__augcVozBootId ?? (globalForVoz.__augcVozBootId = randomUUID());

/** "en_cola" o "procesando" Y de este proceso. */
export function esCorridaViva(v: VersionDeVoz): boolean {
  return (v.estado === "en_cola" || v.estado === "procesando") && v.bootId === BOOT_ID;
}

/** La version viva del proyecto, si la hay. Hay a lo sumo una (una corrida por proyecto, R7.3). */
export function corridaVivaDe(project: ProjectRecord): VersionDeVoz | null {
  return (project.versionesVoz ?? []).find(esCorridaViva) ?? null;
}
