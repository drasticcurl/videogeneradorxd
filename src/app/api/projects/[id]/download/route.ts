/**
 * GET /api/projects/:id/download
 *
 * Arma un .zip con todos los clips de video generados/subidos (+ el video unido si
 * existe) y lo devuelve como descarga (Content-Disposition: attachment). El
 * navegador la guarda en la carpeta de Descargas configurada (por defecto
 * ~/Downloads en macOS).
 *
 * Usa el binario `zip` del sistema via spawn (mismo patron que ffmpeg/ffprobe en
 * src/lib/ffmpeg.ts): sin dependencias npm nuevas. Streamea el zip directo a la
 * response (stdout -> Response), asi no carga todo el archivo en RAM: importante
 * para VSLs largos con muchos clips pesados (ej. 95 clips).
 *
 * OJO con el binario: `zip` NO viene en una imagen minima de servidor. Ubuntu 24.04
 * Server no lo trae (si trae tar y gzip), asi que hay que instalarlo aparte:
 * `sudo apt-get install -y zip`. El deploy lo verifica y avisa (ver deploy.sh).
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { Readable } from "node:stream";
import { jobsDb, projectsDb } from "@/lib/db";
import { absPathFor, buildManifest, slugify } from "@/lib/storage";
import { badRequest, notFound, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Se cachea SOLO el resultado positivo.
 *
 * Antes se cacheaba tambien el negativo, y eso genero este problema real: la VPS no
 * tenia `zip`, se instalo, y la descarga siguio fallando igual porque el proceso ya
 * habia guardado "no esta" para toda su vida. Habia que reiniciar PM2 para algo que
 * ya estaba resuelto.
 *
 * Cachear solo el si no cuesta nada: el chequeo es un spawnSync de milisegundos y
 * corre unicamente cuando alguien aprieta Descargar, que no es un camino caliente.
 */
let zipAvailable = false;

function hasZip(): boolean {
  if (zipAvailable) return true;
  try {
    zipAvailable = spawnSync("zip", ["-v"], { stdio: "ignore" }).status === 0;
  } catch {
    zipAvailable = false;
  }
  return zipAvailable;
}

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const project = projectsDb.get(params.id);
    if (!project) return notFound("Proyecto no encontrado");

    if (!hasZip()) {
      /*
        El mensaje anterior decia que zip "viene instalado por defecto en
        macOS/Linux". En macOS si; en una imagen minima de servidor NO: Ubuntu 24.04
        Server no lo trae, y por eso esta descarga fallaba en la VPS. Ahora el error
        dice que hacer en vez de afirmar algo falso.
      */
      return badRequest(
        "Falta el comando 'zip' en el servidor. Instalalo con: sudo apt-get install -y zip"
      );
    }

    const manifest = buildManifest(project, jobsDb.byProject(project.id));

    /*
      Que meter en el zip. Antes juntaba SOLO videos, y eso dejaba a los proyectos de
      /imagenes sin ninguna forma de descarga: no tienen clips, asi que el boton
      contestaba "todavia no hay videos" para siempre aunque hubiera 4 imagenes listas.

      El default es automatico: si el proyecto tiene videos, manda videos (es lo que se
      espera de un VSL); si no tiene ninguno, manda las imagenes. Con `?que=` se fuerza.
    */
    const que = new URL(_req.url).searchParams.get("que") ?? "auto";
    const seen = new Set<string>();
    const absPaths: string[] = [];

    const agregar = (rel: string | null | undefined): void => {
      if (!rel) return;
      const abs = absPathFor(project.id, rel);
      if (!fs.existsSync(abs) || seen.has(abs)) return;
      seen.add(abs);
      absPaths.push(abs);
    };

    const hayVideos = manifest.clips.some(
      (c) => c.file && fs.existsSync(absPathFor(project.id, c.file))
    );
    const quiereVideos =
      que === "videos" || que === "todo" || (que === "auto" && hayVideos);
    const quiereImagenes =
      que === "imagenes" || que === "todo" || (que === "auto" && !hayVideos);

    if (quiereVideos) {
      for (const clip of [...manifest.clips].sort((a, b) => a.orden - b.orden)) {
        agregar(clip.file);
      }
      agregar(manifest.final_video);
    }
    if (quiereImagenes) {
      // Solo las APROBADAS: los candidatos sin elegir son borradores y meterlos en el
      // zip obligaria a adivinar cual era el bueno al abrirlo.
      for (const img of manifest.images) agregar(img.file);
    }

    if (absPaths.length === 0) {
      return badRequest(
        quiereVideos && !quiereImagenes
          ? "Todavia no hay videos generados para descargar."
          : "Todavia no hay nada generado y aprobado para descargar."
      );
    }

    // "-j" junta todo en la raiz del zip (junk paths, sin la carpeta "clips/"
    // adelante). Como los nombres ya vienen con prefijo de orden (01_, 02_, ...)
    // no hay colision real en el caso comun.
    const zipName = `${slugify(project.name || project.id)}_videos.zip`;
    const child = spawn("zip", ["-j", "-q", "-", ...absPaths], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Best-effort: si zip escribe algo en stderr lo mandamos al log del server,
    // pero no bloqueamos el streaming por eso (los warnings no deberian cortar
    // la descarga si al menos un archivo se pudo agregar).
    child.stderr.on("data", (chunk) => {
      console.error(`[download zip:${project.id}]`, chunk.toString());
    });
    child.on("error", (err) => {
      console.error(`[download zip:${project.id}] fallo al iniciar zip:`, err);
    });

    const webStream = Readable.toWeb(
      child.stdout
    ) as ReadableStream<Uint8Array>;

    return new Response(webStream, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${zipName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return serverError(err);
  }
}
