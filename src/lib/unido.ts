/**
 * ¿El video unido sigue correspondiendo a los clips actuales?
 * Contrato de tasks/cambio-de-voz/02-DISENO.md §7.2.
 *
 * El cambio de voz pega audio nuevo sobre el video del unido usando la receta que dejo
 * el stitch (donde cae cada clip). Si un clip se regenero despues de unir, las cuentas
 * igual cierran y la voz queda pegada sobre un video que ya no es el de los clips: sin
 * un solo error. Por eso, antes de convertir, se compara la receta con lo que hay en
 * disco, y cualquier diferencia bloquea con un motivo concreto (R8).
 *
 * SOLO LEE. Se llama en cada polling de GET /voz (cada 2 s): guardar el proyecto o el
 * manifest desde aca reescribiria db.json en cada tick.
 */
import fs from "node:fs";
import { absPathFor, buildManifest } from "./storage";
import type { EstadoUnido, JobRecord, ProjectRecord, RecetaUnido } from "./types";

const MOTIVO_SIN_RECETA =
  "Este video se unió antes del cambio de voz. Volvé a unir una vez para habilitarlo.";

/** Posicion con dos digitos, como la muestra la pantalla ("01", "02"...). */
const nn = (i: number): string => String(i + 1).padStart(2, "0");

export function estadoDelUnido(project: ProjectRecord, jobs: JobRecord[]): EstadoUnido {
  const manifest = buildManifest(project, jobs);
  const finalVideo = manifest.final_video;
  if (!finalVideo) {
    return { existe: false, file: null, conReceta: false, desactualizado: false, motivo: null, creadoEn: null };
  }

  const receta = project.recetaUnido;
  /*
    Una receta de OTRO archivo (el proyecto se renombro y el unido viejo quedo con el
    nombre anterior, o es un final.mp4 legacy) no describe este unido: se trata como
    sin receta, que pide volver a unir, y no como vigente (D7).
  */
  if (!receta || receta.file !== finalVideo) {
    return { existe: true, file: finalVideo, conReceta: false, desactualizado: false, motivo: MOTIVO_SIN_RECETA, creadoEn: null };
  }

  const base = { existe: true, file: finalVideo, conReceta: true, creadoEn: receta.creadoEn };

  // Mismo filtro que stitchProject: con archivo en disco, por `orden`.
  const actuales = manifest.clips
    .filter((c) => c.file && fs.existsSync(absPathFor(project.id, c.file)))
    .sort((a, b) => a.orden - b.orden);

  const motivo = primerMotivo(project.id, receta, actuales);
  return { ...base, desactualizado: motivo !== null, motivo };
}

function primerMotivo(
  projectId: string,
  receta: RecetaUnido,
  actuales: { id: string; file: string | null }[],
): string | null {
  if (actuales.length > receta.clips.length) {
    return `Hay ${actuales.length - receta.clips.length} clip(s) nuevo(s) desde que se unió.`;
  }
  if (actuales.length < receta.clips.length) {
    return "Se sacaron clips desde que se unió.";
  }
  // Mismo largo: clip por clip, en orden; el primer caso que aplica da el motivo (§7.2).
  for (let i = 0; i < receta.clips.length; i++) {
    const r = receta.clips[i];
    if (r.id !== actuales[i].id) {
      return "Cambió el orden de los clips desde que se unió.";
    }
    if (r.file !== actuales[i].file) {
      return `El clip ${nn(i)} cambió de archivo después de unir.`;
    }
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(absPathFor(projectId, r.file));
    } catch {
      stat = null;
    }
    if (!stat || Math.trunc(stat.mtimeMs) !== r.mtimeMs || stat.size !== r.bytes) {
      return `El clip ${nn(i)} (${r.id}) se regeneró o reemplazó después de unir.`;
    }
  }
  return null;
}

/** La receta si existe y NO esta desactualizada; si no, null. */
export function recetaVigente(project: ProjectRecord, jobs: JobRecord[]): RecetaUnido | null {
  const e = estadoDelUnido(project, jobs);
  if (!e.existe || !e.conReceta || e.desactualizado) return null;
  return project.recetaUnido ?? null;
}
