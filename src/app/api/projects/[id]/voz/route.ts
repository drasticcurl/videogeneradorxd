/**
 * /api/projects/:id/voz — el cambio de voz de un proyecto (contrato §11 de
 * tasks/cambio-de-voz/02-DISENO.md).
 *
 *   GET                       estado para la pantalla Resultado (y su polling cada 2 s)
 *   POST { accion }           convertir | probar (202, la corrida sigue sola) | cancelar
 *   DELETE ?version=<id>      borra una version y su archivo
 *
 * El usuario sale SIEMPRE de la cookie (requireProjectOwner), nunca del body. El
 * proveedor se arma aca con getVozProvider y se INYECTA en la corrida (§3).
 */
import { config } from "@/lib/config";
import { jobsDb, projectsDb } from "@/lib/db";
import { notFound, ok, serverError } from "@/lib/http";
import { requireProjectOwner } from "@/lib/ownership";
import { removeRel } from "@/lib/storage";
import type { AjustesDeVoz, EstimacionDeVoz, RecetaUnido, RespuestaEstadoVoz } from "@/lib/types";
import { estadoDelUnido, recetaVigente } from "@/lib/unido";
import {
  ErrorDeCorrida,
  cancelarCorrida,
  iniciarCorrida,
  reconciliarTrasReinicio,
} from "@/lib/voz/corrida";
import { corridaVivaDe, esCorridaViva } from "@/lib/voz/estado";
import { getVozProvider, vozDisponible } from "@/lib/voz/index";
import { ErrorDeVoz, VOICE_ID_RE } from "@/lib/voz/tipos";
import { armarPiezas, estimar, ventanaDePrueba } from "@/lib/voz/tramos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const error = (status: number, mensaje: string, codigo?: string) =>
  ok(codigo ? { error: mensaje, codigo } : { error: mensaje }, { status });

function estimacionesDe(receta: RecetaUnido, filmados: number): NonNullable<RespuestaEstadoVoz["estimacion"]> {
  const { tramoMaxSeg: maxSeg, pruebaSeg, facturacion, precioPorMinUsd } = config.voz;
  const est = (incluirFilmados: boolean, ventana?: { inicioSeg: number; finSeg: number }): EstimacionDeVoz =>
    estimar(armarPiezas(receta, { incluirFilmados, maxSeg, ventana }), {
      facturacion,
      precioPorMinUsd,
      duracionTotalSeg: receta.duracionSeg,
    });
  const ventana = ventanaDePrueba(receta, { incluirFilmados: false, pruebaSeg });
  return {
    sinFilmados: est(false),
    conFilmados: filmados > 0 ? est(true) : null,
    // Sin clips para convertir no hay ventana: una estimacion en cero (el POST lo rechaza).
    prueba: ventana ? est(false, ventana) : { segundos: 0, tramos: 0, creditos: 0, usd: 0 },
  };
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const guard = requireProjectOwner(params.id);
    if (!guard.ok) return guard.response;
    reconciliarTrasReinicio();
    const project = projectsDb.get(params.id);
    if (!project) return notFound("Proyecto no encontrado");

    const jobs = jobsDb.byProject(project.id);
    const unido = estadoDelUnido(project, jobs);
    const receta = recetaVigente(project, jobs);
    const filmadosConDialogo = receta
      ? receta.clips.filter((c) => c.etiqueta === "FILMAR_REAL" && c.conDialogo).length
      : project.plan.clips.filter((c) => c.etiqueta === "FILMAR_REAL" && c.dialogo?.trim()).length;
    const disp = vozDisponible(guard.user);

    const respuesta: RespuestaEstadoVoz = {
      proveedor: config.voz.proveedor,
      disponible: disp.disponible,
      motivoNoDisponible: disp.motivo,
      unido,
      estimacion: receta ? estimacionesDe(receta, filmadosConDialogo) : null,
      filmadosConDialogo,
      versiones: project.versionesVoz ?? [],
      activa: corridaVivaDe(project),
    };
    return ok(respuesta);
  } catch (err) {
    return serverError(err);
  }
}

const esUnidad = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;

function leerAjustes(a: unknown): AjustesDeVoz | null | "invalido" {
  if (a === undefined || a === null) return null;
  if (typeof a !== "object") return "invalido";
  const o = a as Record<string, unknown>;
  if (!esUnidad(o.estabilidad) || !esUnidad(o.similitud) || !esUnidad(o.estilo) || typeof o.realceHablante !== "boolean") {
    return "invalido";
  }
  return { estabilidad: o.estabilidad, similitud: o.similitud, estilo: o.estilo, realceHablante: o.realceHablante };
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const guard = requireProjectOwner(params.id);
    if (!guard.ok) return guard.response;
    reconciliarTrasReinicio();
    const project = projectsDb.get(params.id);
    if (!project) return notFound("Proyecto no encontrado");

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return error(400, "Cuerpo inválido.");

    if (body.accion === "cancelar") {
      return ok({ cancelada: cancelarCorrida(project.id) });
    }
    if (body.accion !== "convertir" && body.accion !== "probar") {
      return error(400, "La acción tiene que ser convertir, probar o cancelar.");
    }

    // Validacion a mano: voz.id va a una URL de ElevenLabs con la key del server (D13).
    const voz = body.voz as { id?: unknown; nombre?: unknown } | undefined;
    const vozId = typeof voz?.id === "string" ? voz.id : "";
    const vozNombre = typeof voz?.nombre === "string" ? voz.nombre.trim() : "";
    if (!VOICE_ID_RE.test(vozId)) return error(400, "El id de la voz no es válido.");
    if (vozNombre.length < 1 || vozNombre.length > 80) return error(400, "El nombre de la voz tiene que tener entre 1 y 80 caracteres.");
    const ajustes = leerAjustes(body.ajustes);
    if (ajustes === "invalido") return error(400, "Los ajustes de la voz tienen que estar entre 0 y 1.");
    if (body.quitarRuido !== undefined && typeof body.quitarRuido !== "boolean") return error(400, "quitarRuido tiene que ser true o false.");
    if (body.incluirFilmados !== undefined && typeof body.incluirFilmados !== "boolean") return error(400, "incluirFilmados tiene que ser true o false.");

    try {
      const proveedor = getVozProvider(guard.user);
      const version = iniciarCorrida({
        projectId: project.id,
        usuario: guard.user,
        proveedor,
        opciones: {
          voz: { id: vozId, nombre: vozNombre },
          ajustes,
          quitarRuido: body.quitarRuido !== false,
          incluirFilmados: body.incluirFilmados === true,
          prueba: body.accion === "probar",
        },
      });
      return ok({ version }, { status: 202 });
    } catch (err) {
      if (err instanceof ErrorDeVoz && err.codigo === "no_configurado") return error(503, err.message, "no_configurado");
      if (err instanceof ErrorDeCorrida) return error(err.codigo === "ocupado" ? 409 : 400, err.message, err.codigo);
      throw err;
    }
  } catch (err) {
    return serverError(err);
  }
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  try {
    const guard = requireProjectOwner(params.id);
    if (!guard.ok) return guard.response;
    reconciliarTrasReinicio();
    const project = projectsDb.get(params.id);
    if (!project) return notFound("Proyecto no encontrado");

    const versionId = new URL(req.url).searchParams.get("version") ?? "";
    const v = (project.versionesVoz ?? []).find((x) => x.id === versionId);
    if (!v) return notFound("Esa versión no existe en este proyecto.");
    if (esCorridaViva(v)) return error(409, "Esa versión se está convirtiendo: cancelala primero.", "viva");

    if (v.file) await removeRel(project.id, v.file);
    // Releido despues del await: no se pisa lo que haya cambiado entre medio (§10.2 regla 3).
    const actual = projectsDb.get(project.id);
    if (actual) {
      projectsDb.update(project.id, { versionesVoz: (actual.versionesVoz ?? []).filter((x) => x.id !== versionId) });
    }
    return ok({ borrada: true });
  } catch (err) {
    return serverError(err);
  }
}
