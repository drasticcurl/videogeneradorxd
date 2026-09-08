#!/usr/bin/env node
/**
 * MIGRACION — asignar `owner` a los proyectos que ya existen en db.json.
 *
 * Este archivo es el ARTEFACTO CANONICO de la migracion. Ya se ejecuto contra una
 * base scratch (ver `_verificacion-migracion.mjs`, todo en verde). T01 lo copia
 * TAL CUAL a `scripts/migrar-owner.mjs`: no lo tipees de nuevo ni lo "mejores".
 *
 *   node scripts/migrar-owner.mjs --db /srv/generador/storage/data/db.json --dry-run
 *   node scripts/migrar-owner.mjs --db /srv/generador/storage/data/db.json
 *
 * ─── QUE PROBLEMA RESUELVE ───────────────────────────────────────────────────
 *
 * Los ~12 proyectos que ya estan en produccion no tienen dueño, y no hay forma de
 * deducirlo del dato: nadie guardo quien los creo. Sin esta migracion, en cuanto el
 * filtro por dueño entra en vigor esos proyectos quedan invisibles para TODOS (el
 * filtro es `p.owner === usuario`, y `undefined` no matchea con nadie).
 *
 * El mapeo lo decidio el usuario: todos a `lucho` menos cuatro, que son de `ivan`.
 *
 * ─── POR QUE FALLA FUERTE SI NO ENCUENTRA LOS 4 NOMBRES ──────────────────────
 *
 * Los cuatro nombres de abajo se transcribieron a mano de un mensaje. Si uno tiene
 * un caracter distinto al de la DB (un `0` por una `O`, un guion bajo de mas), el
 * matcheo falla EN SILENCIO y ese proyecto de Ivan termina asignado a Lucho: el
 * script diria "12 proyectos migrados, todo OK" y el error solo se descubre cuando
 * Ivan entra y no ve su trabajo.
 *
 * Por eso: si falta alguno de los 4, el script NO ESCRIBE NADA y sale con codigo 1
 * mostrando los nombres reales de la DB para comparar a ojo. Para seguir igual (por
 * ejemplo, si un proyecto se borro de verdad) hay que pasar `--permitir-faltantes`,
 * que es una decision explicita y queda en el log de la terminal.
 *
 * ─── GARANTIAS ───────────────────────────────────────────────────────────────
 *
 *  - BACKUP primero: `db.json.bak-<timestamp>`. Si algo sale mal, se restaura con cp.
 *  - IDEMPOTENTE: solo escribe `owner` donde no habia uno. Correrlo dos veces
 *    reporta "0 cambios". Importa porque un deploy que falle a mitad puede dejar al
 *    operador corriendolo de nuevo sin saber si el primero termino.
 *  - NO PIERDE CAMPOS: se hace spread del proyecto entero y se agrega una clave. No
 *    se reconstruye el objeto campo por campo, que es como se pierde `imageSize` o
 *    `stage` en una migracion escrita a mano.
 *  - NO TOCA `jobs` NI `logs`: el dueño de un job se resuelve por su `projectId`.
 *    Duplicar el dato en el job abre la puerta a que los dos no coincidan.
 *  - ESCRITURA ATOMICA (tmp + rename), igual que `src/lib/db.ts`: si el proceso muere
 *    a mitad de la escritura, `db.json` queda entero (el viejo), no truncado.
 *  - CONTEO ANTES/DESPUES: si la cantidad de proyectos, jobs o logs cambia, aborta
 *    antes de renombrar. Esta migracion no puede perder un proyecto.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Los cuatro proyectos de Ivan, por NOMBRE EXACTO.
 *
 * Se matchea por nombre y no por id porque el usuario los identifico por nombre;
 * los ids son UUID y no los tiene a mano. La comparacion es exacta salvo espacios
 * al borde (`trim`): no se normaliza mayusculas ni acentos a proposito, porque un
 * match laxo podria capturar un proyecto parecido que es de Lucho.
 */
const PROYECTOS_DE_IVAN = [
  "AA_rendicion_meresigne_duena52_v02",
  "AA_rendicion_meresigne_duena52_v01",
  "AA_alquiler_marcodepuerta_duena31_v01",
  "AA_manerastontas_multivoz_v01",
];

/** Todo lo que no este en la lista de arriba va a este dueño. */
const DUEÑO_POR_DEFECTO = "lucho";

// ─── Argumentos ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { db: null, dryRun: false, permitirFaltantes: false, owner: DUEÑO_POR_DEFECTO };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") args.db = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--permitir-faltantes") args.permitirFaltantes = true;
    else if (a === "--default-owner") args.owner = String(argv[++i] || "").toLowerCase();
    else if (a === "--help" || a === "-h") args.help = true;
    else {
      console.error(`Argumento desconocido: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

const args = parseArgs(process.argv);

if (args.help || !args.db) {
  console.log(`
Uso: node migrar-owner.mjs --db <ruta a db.json> [opciones]

  --db <ruta>              obligatorio. Ruta al db.json a migrar.
  --dry-run                muestra que haria, sin escribir ni hacer backup.
  --default-owner <nombre> dueño de todo lo que no sea de Ivan (default: ${DUEÑO_POR_DEFECTO}).
  --permitir-faltantes     seguir aunque no aparezca alguno de los 4 de Ivan.
                           Es una decision explicita: leé el reporte antes.
`);
  process.exit(args.help ? 0 : 2);
}

// ─── Leer ───────────────────────────────────────────────────────────────────

const dbPath = path.resolve(args.db);
if (!fs.existsSync(dbPath)) {
  console.error(`ERROR: no existe ${dbPath}`);
  process.exit(1);
}

let db;
try {
  db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
} catch (err) {
  console.error(`ERROR: ${dbPath} no es JSON valido: ${err.message}`);
  process.exit(1);
}

const projects = db.projects ?? {};
const idsAntes = Object.keys(projects);
const jobsAntes = Object.keys(db.jobs ?? {}).length;
const logsAntes = Object.keys(db.logs ?? {}).length;

console.log(`\n═══ migracion de owner — ${dbPath} ═══`);
console.log(`proyectos: ${idsAntes.length} · jobs: ${jobsAntes} · logs: ${logsAntes}`);
if (args.dryRun) console.log("MODO --dry-run: no se escribe nada.\n");
else console.log("");

// ─── Chequear que los 4 de Ivan existan, ANTES de tocar nada ────────────────

const porNombre = new Map();
for (const [id, p] of Object.entries(projects)) {
  const nombre = String(p?.name ?? "").trim();
  if (!porNombre.has(nombre)) porNombre.set(nombre, []);
  porNombre.get(nombre).push(id);
}

const faltantes = PROYECTOS_DE_IVAN.filter((n) => !porNombre.has(n));
const duplicados = PROYECTOS_DE_IVAN.filter((n) => (porNombre.get(n)?.length ?? 0) > 1);

if (faltantes.length > 0) {
  console.error("ERROR: no se encontraron estos proyectos de Ivan, por nombre exacto:");
  for (const n of faltantes) console.error(`  · ${n}`);
  console.error("\nLos nombres que SI estan en la DB, para comparar a ojo:");
  for (const n of [...porNombre.keys()].sort()) console.error(`  · ${n}`);
  console.error(
    "\nSi el nombre cambio o el proyecto se borro, corré de nuevo con --permitir-faltantes.\n" +
      "NO se escribio nada.",
  );
  if (!args.permitirFaltantes) process.exit(1);
  console.error("\n--permitir-faltantes: se sigue igual, por decision explicita.\n");
}

if (duplicados.length > 0) {
  console.error("ERROR: hay mas de un proyecto con el mismo nombre de la lista de Ivan:");
  for (const n of duplicados) console.error(`  · ${n} → ${porNombre.get(n).join(", ")}`);
  console.error("\nResolvelo a mano (renombrando uno) y volvé a correr. NO se escribio nada.");
  process.exit(1);
}

// ─── Asignar ────────────────────────────────────────────────────────────────

const idsDeIvan = new Set();
for (const n of PROYECTOS_DE_IVAN) for (const id of porNombre.get(n) ?? []) idsDeIvan.add(id);

let cambios = 0;
let yaTenian = 0;
const filas = [];

for (const [id, p] of Object.entries(projects)) {
  const nombre = String(p?.name ?? "").trim();
  const soloImagenes = Array.isArray(p?.plan?.clips) ? p.plan.clips.length === 0 : null;
  const destino = idsDeIvan.has(id) ? "ivan" : args.owner;

  if (typeof p.owner === "string" && p.owner.length > 0) {
    yaTenian++;
    filas.push({ id, nombre, soloImagenes, owner: p.owner, accion: "ya tenia" });
    continue;
  }

  // Spread del proyecto entero + una clave. NO se reconstruye campo por campo:
  // asi no se pierden `stage`, `imageSize`, `autoApprove` ni nada que se agregue
  // al tipo despues de escribir este script.
  projects[id] = { ...p, owner: destino };
  cambios++;
  filas.push({ id, nombre, soloImagenes, owner: destino, accion: "asignado" });
}

// ─── Reporte ────────────────────────────────────────────────────────────────

filas.sort((a, b) => a.owner.localeCompare(b.owner) || a.nombre.localeCompare(b.nombre));
const anchoNombre = Math.max(6, ...filas.map((f) => f.nombre.length));
console.log(
  `${"dueño".padEnd(6)}  ${"tipo".padEnd(9)}  ${"nombre".padEnd(anchoNombre)}  accion`,
);
console.log("─".repeat(6 + 2 + 9 + 2 + anchoNombre + 2 + 8));
for (const f of filas) {
  const tipo = f.soloImagenes === null ? "?" : f.soloImagenes ? "imagenes" : "video";
  console.log(
    `${f.owner.padEnd(6)}  ${tipo.padEnd(9)}  ${f.nombre.padEnd(anchoNombre)}  ${f.accion}`,
  );
}

const deIvan = filas.filter((f) => f.owner === "ivan");
const imagenesDeIvan = deIvan.filter((f) => f.soloImagenes === true);
console.log(`\nresumen: ${cambios} asignados, ${yaTenian} ya tenian dueño`);
console.log(`         ivan: ${deIvan.length} · ${args.owner}: ${filas.length - deIvan.length}`);

// El usuario dijo "las imagenes, todas a lucho" Y ademas nombro 4 proyectos de Ivan.
// Si alguno de esos 4 resulta ser un proyecto de solo imagenes, las dos reglas se
// contradicen. Gana la lista explicita (es mas especifica), pero se avisa fuerte
// para que el operador lo confirme en vez de que pase desapercibido.
if (imagenesDeIvan.length > 0) {
  console.log(
    `\nAVISO: ${imagenesDeIvan.length} de los proyectos de Ivan son de SOLO IMAGENES:`,
  );
  for (const f of imagenesDeIvan) console.log(`  · ${f.nombre}`);
  console.log(
    "  El usuario dijo 'las imagenes todas a lucho' y tambien nombro estos 4 como de Ivan.\n" +
      "  Gano la lista explicita. Si esta mal, corregilo a mano y avisale.",
  );
}

if (args.dryRun) {
  console.log("\n--dry-run: no se escribio nada.\n");
  process.exit(0);
}

if (cambios === 0) {
  console.log("\nnada que hacer: todos los proyectos ya tenian dueño.\n");
  process.exit(0);
}

// ─── Conteos antes de escribir ──────────────────────────────────────────────

const idsDespues = Object.keys(projects);
if (idsDespues.length !== idsAntes.length) {
  console.error(
    `ERROR: la cantidad de proyectos cambio (${idsAntes.length} → ${idsDespues.length}). NO se escribe.`,
  );
  process.exit(1);
}
if (Object.keys(db.jobs ?? {}).length !== jobsAntes) {
  console.error("ERROR: cambio la cantidad de jobs. NO se escribe.");
  process.exit(1);
}
if (Object.keys(db.logs ?? {}).length !== logsAntes) {
  console.error("ERROR: cambio la cantidad de logs. NO se escribe.");
  process.exit(1);
}

// ─── Backup + escritura atomica ─────────────────────────────────────────────

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = `${dbPath}.bak-${stamp}`;
fs.copyFileSync(dbPath, backup);
console.log(`\nbackup: ${backup}`);

const tmp = `${dbPath}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
fs.renameSync(tmp, dbPath);

console.log(`escrito: ${dbPath} (${cambios} proyectos con dueño nuevo)`);
console.log("\nPara revertir:");
console.log(`  cp ${backup} ${dbPath}\n`);
