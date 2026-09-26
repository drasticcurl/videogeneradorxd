/**
 * La cuenta de Vertex de cada usuario: la que cargo desde la app (el header, "Tu
 * configuración" → "Cuenta de Vertex"), y si no cargo ninguna, la del environment
 * (`vertexCuentaDelEnv`).
 *
 *   vertexCuentaFor(usuario)  →  1. la cargada desde la app
 *                                2. `GOOGLE_*_<NOMBRE>` del .env (la configuro el admin)
 *                                3. la compartida
 *
 * La de la app gana porque es la decision mas reciente y la tomo el propio usuario: si el
 * admin le habia dejado una en el .env y el sube la suya, tiene que usarse la suya.
 *
 * ─── DONDE VIVE ──────────────────────────────────────────────────────────────
 *
 *   <DATA_DIR>/cuentas-vertex/cuentas.json       quien tiene cuenta: proyecto, email, fecha
 *   <DATA_DIR>/cuentas-vertex/<usuario>-<ts>.json la llave, con permisos 600
 *
 * En DATA_DIR y NO en OUTPUT_DIR a proposito: /api/files sirve lo que hay en OUTPUT_DIR,
 * y DATA_DIR no lo sirve ninguna ruta. La llave no vuelve a salir del server: ninguna
 * respuesta la trae, ni el path.
 *
 * El nombre de la llave cambia en cada carga (`-<ts>`). auth.ts cachea un GoogleAuth por
 * path, y ese GoogleAuth guarda la llave que leyo la primera vez: reemplazarla en el
 * mismo path seguiria generando con la vieja hasta reiniciar el proceso.
 *
 * Mismo patron que voz/favoritas.ts: escritura atomica (tmp + rename), singleton por
 * globalThis y un cuentas.json roto se aparta a `.roto-<ts>` en vez de pisarse.
 */
import fs from "node:fs";
import path from "node:path";

import { config, vertexCuentaDelEnv, type CuentaVertex } from "./config";
import { probarCuenta } from "./providers/vertex/auth";
import type { EstadoCuentaVertex, PruebaCuentaVertex } from "./types";

interface CuentaCargada {
  proyecto: string;
  tipo: "service_account" | "authorized_user";
  email: string | null;
  /** Nombre del archivo de la llave, adentro de la carpeta. Nunca un path. */
  archivo: string;
  cargadaEn: string;
}

interface ArchivoCuentas {
  version: 1;
  porUsuario: Record<string, CuentaCargada>;
}

/** Un JSON de llave real pesa ~2,4 KB. 20 KB deja margen y corta cualquier otra cosa. */
const MAX_BYTES_LLAVE = 20_000;

/**
 * ID de proyecto de Google Cloud: 6 a 30 caracteres, minusculas, digitos y guiones,
 * empieza con letra. No es solo prolijidad: el proyecto va ADENTRO del path de la URL de
 * Vertex (`/projects/<proyecto>/...`), y sin esto un "../" la cambiaria.
 */
const PROYECTO_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

function carpeta(): string {
  return path.join(config.storage.dataDir, "cuentas-vertex");
}
function archivoIndice(): string {
  return path.join(carpeta(), "cuentas.json");
}

/* ───────────────────────────── el indice ───────────────────────────── */

interface Estado {
  datos: ArchivoCuentas;
  /** El archivo en disco no se pudo leer: hay que apartarlo antes de escribir. */
  roto: boolean;
}

function cargar(): Estado {
  const f = archivoIndice();
  try {
    if (!fs.existsSync(f)) return { datos: { version: 1, porUsuario: {} }, roto: false };
    const j = JSON.parse(fs.readFileSync(f, "utf8")) as Partial<ArchivoCuentas>;
    if (!j || typeof j !== "object" || typeof j.porUsuario !== "object" || j.porUsuario === null) {
      throw new Error("forma inesperada");
    }
    return { datos: { version: 1, porUsuario: j.porUsuario }, roto: false };
  } catch (err) {
    console.error("[cuentaVertex] cuentas.json roto, arrancando vacio (se aparta al escribir):", err);
    return { datos: { version: 1, porUsuario: {} }, roto: true };
  }
}

const globalForCuentas = globalThis as unknown as { __augcCuentasVertex?: Estado };
function estado(): Estado {
  return globalForCuentas.__augcCuentasVertex ?? (globalForCuentas.__augcCuentasVertex = cargar());
}

/** Escritura atomica: tmp con permisos 600 desde que nace, y rename. */
function escribirPrivado(f: string, contenido: string): void {
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contenido, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, f);
}

function guardarIndice(e: Estado): void {
  const f = archivoIndice();
  if (e.roto) {
    if (fs.existsSync(f)) fs.renameSync(f, `${f}.roto-${Date.now()}`);
    e.roto = false;
  }
  escribirPrivado(f, JSON.stringify(e.datos, null, 2));
}

function borrarLlave(archivo: string): void {
  try {
    fs.rmSync(path.join(carpeta(), archivo), { force: true });
  } catch (err) {
    // Que quede un archivo de mas no rompe nada: el indice ya no lo nombra.
    console.error("[cuentaVertex] no se pudo borrar la llave vieja:", err);
  }
}

/* ───────────────────────────── resolucion ───────────────────────────── */

/**
 * La cuenta con la que genera `usuario`. `null` (un proyecto viejo sin dueño) usa la
 * compartida. Ver el orden en el encabezado.
 *
 * Es la que llaman los adaptadores de Vertex, la cola (para la ventana de videos por
 * cuenta) y la UI. Lee de memoria: el indice se carga una vez por proceso, y como la app
 * corre en UNA instancia, las escrituras de este mismo modulo lo mantienen al dia.
 */
export function vertexCuentaFor(usuario: string | null): CuentaVertex {
  const cargada = usuario ? estado().datos.porUsuario[usuario] : undefined;
  if (usuario && cargada) {
    return {
      proyecto: cargada.proyecto,
      credenciales: path.join(carpeta(), cargada.archivo),
      usuario,
      origen: "app",
    };
  }
  return vertexCuentaDelEnv(usuario);
}

/** Lo que la UI puede saber de la cuenta de un usuario. Nunca la llave ni su path. */
export function estadoCuentaVertex(usuario: string): EstadoCuentaVertex {
  const modo = config.providerMode === "vertex" ? "vertex" : "mock";
  const cargada = estado().datos.porUsuario[usuario];
  if (cargada) {
    return {
      modo,
      origen: "app",
      proyecto: cargada.proyecto,
      email: cargada.email,
      tipo: cargada.tipo,
      cargadaEn: cargada.cargadaEn,
    };
  }
  const cuenta = vertexCuentaDelEnv(usuario);
  return {
    modo,
    origen: cuenta.proyecto ? cuenta.origen : "ninguna",
    proyecto: cuenta.proyecto || null,
    email: null,
    tipo: null,
    cargadaEn: null,
  };
}

/* ─────────────────────────── cargar una cuenta ─────────────────────────── */

/** Un error que la ruta devuelve tal cual al usuario (400), porque es de lo que subio. */
export class ErrorDeCuenta extends Error {}

type Llave =
  | {
      type: "service_account";
      project_id?: string;
      private_key_id?: string;
      private_key: string;
      client_email: string;
      client_id?: string;
    }
  | {
      type: "authorized_user";
      client_id: string;
      client_secret: string;
      refresh_token: string;
    };

const esTexto = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/**
 * Valida el JSON subido y devuelve SOLO los campos que hacen falta para sacar un token.
 *
 * Se aceptan dos tipos y ninguno mas. `external_account` y compañia existen y
 * google-auth-library los acepta, pero su JSON le puede pedir al server que lea un
 * archivo, que corra un ejecutable o que le pegue a una URL para conseguir el token: con
 * un JSON subido desde la web eso no puede pasar. Y se reescribe con los campos de la
 * lista por lo mismo: lo que no esta en la lista no llega nunca a la libreria.
 */
function limpiarLlave(texto: string): { llave: Llave; proyectoDelJson: string | null } {
  if (texto.length > MAX_BYTES_LLAVE) {
    throw new ErrorDeCuenta("Ese archivo es demasiado grande para ser la llave de una cuenta.");
  }
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(texto) as Record<string, unknown>;
  } catch {
    throw new ErrorDeCuenta("Ese archivo no es un JSON. Elegí el .json que descargaste de Google.");
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) {
    throw new ErrorDeCuenta("Ese JSON no tiene la forma de una llave de Google Cloud.");
  }
  // El error mas comun: bajar el JSON de un "ID de cliente de OAuth" en vez de la clave.
  if ("installed" in j || "web" in j) {
    throw new ErrorDeCuenta(
      "Ese es el JSON de un \"ID de cliente de OAuth\", no la clave de una cuenta de servicio. " +
        "Seguí los pasos 3 y 4 del tutorial.",
    );
  }

  if (j.type === "service_account") {
    if (!esTexto(j.client_email) || !esTexto(j.private_key) || !j.private_key.includes("PRIVATE KEY")) {
      throw new ErrorDeCuenta("A esa llave de cuenta de servicio le falta el email o la clave privada.");
    }
    return {
      llave: {
        type: "service_account",
        project_id: esTexto(j.project_id) ? j.project_id : undefined,
        private_key_id: esTexto(j.private_key_id) ? j.private_key_id : undefined,
        private_key: j.private_key,
        client_email: j.client_email,
        client_id: esTexto(j.client_id) ? j.client_id : undefined,
      },
      proyectoDelJson: esTexto(j.project_id) ? j.project_id : null,
    };
  }
  if (j.type === "authorized_user") {
    if (!esTexto(j.client_id) || !esTexto(j.client_secret) || !esTexto(j.refresh_token)) {
      throw new ErrorDeCuenta("A ese login de gcloud le falta el client_id, el secret o el refresh_token.");
    }
    return {
      llave: {
        type: "authorized_user",
        client_id: j.client_id,
        client_secret: j.client_secret,
        refresh_token: j.refresh_token,
      },
      proyectoDelJson: esTexto(j.quota_project_id) ? j.quota_project_id : null,
    };
  }
  throw new ErrorDeCuenta(
    `Ese JSON es de tipo "${String(j.type ?? "desconocido")}". Tiene que ser la clave de una ` +
      "cuenta de servicio (service_account) o el login de gcloud (authorized_user).",
  );
}

/**
 * Carga (o reemplaza) la cuenta de un usuario. PRIMERO la prueba contra Google, sin
 * gastar (`probarCuenta`), y solo si pasa la guarda: una cuenta que no anda no se guarda,
 * porque dejaria los jobs de ese usuario fallando en rojo hasta que alguien se de cuenta.
 *
 * `proyecto` vacio = el del JSON (`project_id` de una cuenta de servicio).
 */
export async function cargarCuenta(
  usuario: string,
  textoLlave: string,
  proyectoPedido: string,
): Promise<{ estado: EstadoCuentaVertex; prueba: PruebaCuentaVertex }> {
  const { llave, proyectoDelJson } = limpiarLlave(textoLlave);
  const proyecto = (proyectoPedido.trim() || proyectoDelJson || "").toLowerCase();
  if (!proyecto) {
    throw new ErrorDeCuenta("Escribí el ID del proyecto: este JSON no lo trae.");
  }
  if (!PROYECTO_RE.test(proyecto)) {
    throw new ErrorDeCuenta(
      `"${proyecto}" no parece un ID de proyecto. Es el ID, no el nombre: 6 a 30 caracteres, ` +
        "minúsculas, números y guiones (por ejemplo mi-proyecto-123456).",
    );
  }

  const aProbar: CuentaVertex = { proyecto, credenciales: "", usuario, origen: "app" };
  const prueba = await probarCuenta(aProbar, llave);
  if (!prueba.ok) return { estado: estadoCuentaVertex(usuario), prueba };

  const archivo = `${usuario}-${Date.now()}.json`;
  escribirPrivado(path.join(carpeta(), archivo), JSON.stringify(llave, null, 2));

  const e = estado();
  const anterior = e.datos.porUsuario[usuario];
  e.datos.porUsuario[usuario] = {
    proyecto,
    tipo: llave.type,
    email: llave.type === "service_account" ? llave.client_email : null,
    archivo,
    cargadaEn: new Date().toISOString(),
  };
  guardarIndice(e);
  // La vieja se borra DESPUES de guardar el indice: si algo falla en el medio, el
  // indice sigue apuntando a una llave que existe.
  if (anterior && anterior.archivo !== archivo) borrarLlave(anterior.archivo);

  return { estado: estadoCuentaVertex(usuario), prueba };
}

/** Saca la cuenta cargada desde la app: el usuario vuelve a la del .env o a la compartida. */
export function quitarCuenta(usuario: string): EstadoCuentaVertex {
  const e = estado();
  const anterior = e.datos.porUsuario[usuario];
  if (anterior) {
    delete e.datos.porUsuario[usuario];
    guardarIndice(e);
    borrarLlave(anterior.archivo);
  }
  return estadoCuentaVertex(usuario);
}

/** Prueba la cuenta que el usuario usa HOY (la que usaria un job), sin gastar. */
export function probarCuentaActual(usuario: string): Promise<PruebaCuentaVertex> {
  const cuenta = vertexCuentaFor(usuario);
  if (!cuenta.proyecto) {
    return Promise.resolve({
      ok: false,
      motivo: "No tenés cuenta de Vertex: cargá la tuya para poder generar.",
      ayuda: null,
    });
  }
  return probarCuenta(cuenta);
}
