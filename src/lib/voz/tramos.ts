/**
 * El armado de piezas del cambio de voz: que partes del audio del unido se mandan a
 * convertir y cuales se conservan, y cuanto cuesta. Contrato de
 * tasks/cambio-de-voz/02-DISENO.md §8.
 *
 * PURO a proposito: solo `import type`, nada de fs ni de config (todo entra por
 * parametro). Es lo unico del modulo con aritmetica no trivial, y asi se prueba con
 * `node` directo: los chequeos B15-B19 de _verificacion-voz.sh llaman a estas funciones
 * de verdad. Un corte corrido un clip compila perfecto y deja la voz fuera de la boca.
 */
import type { ClipEnReceta, EstimacionDeVoz, RecetaUnido } from "../types";

export interface Pieza {
  tipo: "convertir" | "conservar";
  inicioSeg: number;
  finSeg: number | null;     // null = hasta el final del audio (absorbe el relleno del AAC)
  clipIds: string[];
}

/*
  Tolerancia de punto flotante: 16.06 - 8 no da exactamente 8.06, y sin esto un clip que
  entra justo en maxSeg abriria una pieza nueva (un pedido mas, y uno mas que se factura).
*/
const EPS = 1e-9;

export function debeConvertirse(clip: ClipEnReceta, incluirFilmados: boolean): boolean {
  return clip.conDialogo && (clip.etiqueta !== "FILMAR_REAL" || incluirFilmados);
}

/** Piezas sobre TODA la receta, con la ultima terminando en duracionSeg (finito). */
function piezasCompletas(receta: RecetaUnido, incluirFilmados: boolean, maxSeg: number): (Pieza & { finSeg: number })[] {
  const piezas: (Pieza & { finSeg: number })[] = [];
  for (const clip of receta.clips) {
    const tipo = debeConvertirse(clip, incluirFilmados) ? "convertir" : "conservar";
    const ultima = piezas[piezas.length - 1];

    if (tipo === "conservar") {
      // Los que se conservan se juntan sin limite: no van a ningun proveedor.
      if (ultima && ultima.tipo === "conservar") {
        ultima.finSeg = clip.finSeg;
        ultima.clipIds.push(clip.id);
      } else {
        piezas.push({ tipo, inicioSeg: clip.inicioSeg, finSeg: clip.finSeg, clipIds: [clip.id] });
      }
      continue;
    }

    const dur = clip.finSeg - clip.inicioSeg;
    if (dur > maxSeg + EPS) {
      /*
        Unico corte a mitad de clip (regla 3): un clip que solo ya pasa el tope del
        pedido. No pasa en esta app (8 s, 15 s extendido), pero sin esto el pedido
        rebotaria en ElevenLabs.
      */
      let t = clip.inicioSeg;
      while (clip.finSeg - t > EPS) {
        const fin = Math.min(t + maxSeg, clip.finSeg);
        piezas.push({ tipo, inicioSeg: t, finSeg: fin, clipIds: [clip.id] });
        t = fin;
      }
      continue;
    }

    if (ultima && ultima.tipo === "convertir" && clip.finSeg - ultima.inicioSeg <= maxSeg + EPS) {
      ultima.finSeg = clip.finSeg;
      ultima.clipIds.push(clip.id);
    } else {
      piezas.push({ tipo, inicioSeg: clip.inicioSeg, finSeg: clip.finSeg, clipIds: [clip.id] });
    }
  }
  return piezas;
}

export function armarPiezas(
  receta: RecetaUnido,
  opts: { incluirFilmados: boolean; maxSeg: number; ventana?: { inicioSeg: number; finSeg: number } },
): Pieza[] {
  const completas = piezasCompletas(receta, opts.incluirFilmados, opts.maxSeg);
  if (completas.length === 0) return [];

  if (!opts.ventana) {
    // Sin ventana la ultima va "hasta el final": el audio real mide un poco mas que la
    // receta (relleno del AAC) y ese resto tiene que caer en alguna pieza.
    const out: Pieza[] = completas.map((p) => ({ ...p, clipIds: [...p.clipIds] }));
    out[out.length - 1].finSeg = null;
    return out;
  }

  const { inicioSeg: vi, finSeg: vf } = opts.ventana;
  const out: Pieza[] = [];
  for (const p of completas) {
    const inicio = Math.max(p.inicioSeg, vi);
    const fin = Math.min(p.finSeg, vf);
    if (fin - inicio <= EPS) continue;
    // Solo los clips que tocan la pieza DENTRO de la ventana (un clip que empieza
    // despues del fin de la ventana no esta en la prueba).
    const clipIds = receta.clips
      .filter((c) => p.clipIds.includes(c.id) && Math.min(c.finSeg, fin) - Math.max(c.inicioSeg, inicio) > EPS)
      .map((c) => c.id);
    out.push({ tipo: p.tipo, inicioSeg: inicio, finSeg: fin, clipIds });
  }
  if (out.length > 0) out[out.length - 1].finSeg = vf;
  return out;
}

/** Arranca en el primer clip que se convierte. null si no hay ninguno. */
export function ventanaDePrueba(
  receta: RecetaUnido,
  opts: { incluirFilmados: boolean; pruebaSeg: number },
): { inicioSeg: number; finSeg: number } | null {
  const c = receta.clips.find((x) => debeConvertirse(x, opts.incluirFilmados));
  if (!c) return null;
  return { inicioSeg: c.inicioSeg, finSeg: Math.min(c.inicioSeg + opts.pruebaSeg, receta.duracionSeg) };
}

export function estimar(
  piezas: Pieza[],
  opts: { facturacion: "por_minuto" | "proporcional"; precioPorMinUsd: number; duracionTotalSeg: number },
): EstimacionDeVoz {
  const duraciones = piezas
    .filter((p) => p.tipo === "convertir")
    .map((p) => (p.finSeg ?? opts.duracionTotalSeg) - p.inicioSeg);
  const segundos = duraciones.reduce((a, b) => a + b, 0);
  const creditos =
    opts.facturacion === "por_minuto"
      ? // Cada pedido se redondea al minuto: el maximo posible (P-01).
        duraciones.reduce((a, d) => a + Math.ceil(d / 60 - EPS) * 1000, 0)
      : Math.ceil((segundos / 60) * 1000 - EPS);
  return {
    segundos: Math.round(segundos * 1000) / 1000,
    tramos: duraciones.length,
    creditos,
    usd: Math.round((creditos / 1000) * opts.precioPorMinUsd * 100) / 100,
  };
}
