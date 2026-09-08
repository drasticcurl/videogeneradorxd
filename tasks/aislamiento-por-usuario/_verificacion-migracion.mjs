#!/usr/bin/env node
/**
 * VERIFICACION de `_migracion-owner.mjs` contra una base SCRATCH.
 *
 *   node tasks/aislamiento-por-usuario/_verificacion-migracion.mjs
 *
 * Salida esperada: "TODO EN VERDE (7/7)" y exit 0.
 *
 * NUNCA toca produccion ni `./data`: arma su propio db.json en un directorio
 * temporal (`os.tmpdir()`) y lo borra al terminar. El db scratch imita la forma real
 * de `DbShape` (`src/lib/db.ts`): `{ projects, jobs, logs }`, con proyectos que
 * tienen los mismos campos que `ProjectRecord` (`src/lib/types.ts`), incluidos los
 * opcionales (`stage`, `imageSize`, `autoApprove`) — que son justamente los que una
 * migracion mal escrita pierde.
 *
 * Las 7 afirmaciones son las que las tasks van a asumir sin volver a verificar:
 *  1. el dry-run no escribe
 *  2. asigna los 4 de Ivan por nombre y el resto al default
 *  3. no pierde proyectos, jobs ni logs
 *  4. no pierde campos opcionales del ProjectRecord
 *  5. es idempotente (segunda corrida = 0 cambios)
 *  6. si falta un nombre de Ivan, NO escribe y sale 1
 *  7. si hay nombres duplicados, NO escribe y sale 1
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const MIGRACION = path.join(AQUI, "_migracion-owner.mjs");

const NOMBRES_IVAN = [
  "AA_rendicion_meresigne_duena52_v02",
  "AA_rendicion_meresigne_duena52_v01",
  "AA_alquiler_marcodepuerta_duena31_v01",
  "AA_manerastontas_multivoz_v01",
];

let ok = 0;
let fallos = 0;

function afirmar(titulo, porQue, esperado, actual) {
  const paso = JSON.stringify(esperado) === JSON.stringify(actual);
  console.log(`\n═══ ${titulo} ═══`);
  console.log(`    ${porQue}`);
  console.log(`    esperado: ${JSON.stringify(esperado)}`);
  console.log(`    actual:   ${JSON.stringify(actual)}`);
  if (paso) {
    console.log("    OK");
    ok++;
  } else {
    console.log("    FALLO");
    fallos++;
  }
}

/** Un ProjectRecord con la forma real, incluidos los campos opcionales. */
function proyecto(id, name, { clips = 1, extras = {} } = {}) {
  return {
    id,
    name,
    brief: "brief de prueba",
    plan: {
      global: { idioma_dialogo: "es-AR", formato: "9:16" },
      references: [],
      assets: [{ id: "a1", tipo: "avatar", images: [{ id: "a1_base", modo: "text2image", prompt: "x" }] }],
      clips: Array.from({ length: clips }, (_, i) => ({
        id: `c${i + 1}`,
        orden: i + 1,
        asset_id: "a1",
        image_id: "a1_base",
        video_prompt: "x",
        dialogo: "y",
        duracion_seg: 8,
        etiqueta: "IA",
      })),
      warnings: [],
    },
    status: "done",
    models: { llm: "gemini-3.6-flash", image: "gemini-3.1-flash-image", video: "veo-3.1-lite-generate-001" },
    imageVariants: 1,
    defaultResolution: "720p",
    outputDir: `/srv/generador/storage/output/${id}`,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-02T10:00:00.000Z",
    ...extras,
  };
}

/** db.json scratch: 12 proyectos (4 de Ivan), 3 jobs, 1 log. */
function dbScratch() {
  const projects = {};
  // Los 4 de Ivan: proyectos de video (1 clip cada uno).
  NOMBRES_IVAN.forEach((n, i) => {
    projects[`ivan-${i}`] = proyecto(`ivan-${i}`, n, { clips: 1 });
  });
  // 6 de video, con campos opcionales puestos para el chequeo 4.
  for (let i = 0; i < 6; i++) {
    projects[`vid-${i}`] = proyecto(`vid-${i}`, `Proyecto video ${i}`, {
      clips: 2,
      extras: { stage: "videos", autoApprove: false, imageSize: "2K", imageAspectRatio: "9:16" },
    });
  }
  // 2 de solo imagenes (clips vacio).
  for (let i = 0; i < 2; i++) {
    projects[`img-${i}`] = proyecto(`img-${i}`, `Tanda imagenes ${i}`, { clips: 0 });
  }
  return {
    projects,
    jobs: {
      "ivan-0:img:a1_base": { id: "ivan-0:img:a1_base", projectId: "ivan-0", type: "image", refId: "a1_base", status: "done" },
      "ivan-0:vid:c1": { id: "ivan-0:vid:c1", projectId: "ivan-0", type: "video", refId: "c1", status: "done" },
      "vid-0:img:a1_base": { id: "vid-0:img:a1_base", projectId: "vid-0", type: "image", refId: "a1_base", status: "done" },
    },
    logs: { "ivan-0": [{ ts: "2026-08-01T10:00:00.000Z", level: "info", message: "listo" }] },
  };
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gen-migracion-"));
const dbPath = path.join(tmpDir, "db.json");

function escribirScratch(db = dbScratch()) {
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), "utf8");
}
function leer() {
  return JSON.parse(fs.readFileSync(dbPath, "utf8"));
}
function correr(extraArgs = []) {
  try {
    const stdout = execFileSync("node", [MIGRACION, "--db", dbPath, ...extraArgs], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

try {
  // ─── 1. dry-run no escribe ────────────────────────────────────────────────
  escribirScratch();
  const antes = fs.readFileSync(dbPath, "utf8");
  const r1 = correr(["--dry-run"]);
  const despues = fs.readFileSync(dbPath, "utf8");
  afirmar(
    "1. el --dry-run no escribe nada",
    "si escribiera, el operador no tendria forma de ver el mapeo antes de tocar produccion.",
    { code: 0, archivoIgual: true, backups: 0 },
    {
      code: r1.code,
      archivoIgual: antes === despues,
      backups: fs.readdirSync(tmpDir).filter((f) => f.includes(".bak-")).length,
    },
  );

  // ─── 2. asigna los 4 de Ivan y el resto al default ────────────────────────
  const r2 = correr();
  const db2 = leer();
  const porDueño = {};
  for (const p of Object.values(db2.projects)) {
    porDueño[p.owner ?? "SIN_DUEÑO"] = (porDueño[p.owner ?? "SIN_DUEÑO"] ?? 0) + 1;
  }
  const nombresDeIvan = Object.values(db2.projects)
    .filter((p) => p.owner === "ivan")
    .map((p) => p.name)
    .sort();
  afirmar(
    "2. los 4 de Ivan por nombre exacto, el resto a lucho",
    "es el mapeo que dio el usuario. Un error aca le da los proyectos de uno al otro.",
    { code: 0, porDueño: { ivan: 4, lucho: 8 }, nombresDeIvan: [...NOMBRES_IVAN].sort() },
    { code: r2.code, porDueño, nombresDeIvan },
  );

  // ─── 3. no pierde proyectos, jobs ni logs ─────────────────────────────────
  afirmar(
    "3. no se pierde ningun proyecto, job ni log",
    "el usuario dijo explicitamente 'no los quiero perder'. Son 12 proyectos ya pagados.",
    { projects: 12, jobs: 3, logs: 1 },
    {
      projects: Object.keys(db2.projects).length,
      jobs: Object.keys(db2.jobs).length,
      logs: Object.keys(db2.logs).length,
    },
  );

  // ─── 4. no pierde campos opcionales ───────────────────────────────────────
  const v0 = db2.projects["vid-0"];
  afirmar(
    "4. los campos opcionales del ProjectRecord sobreviven",
    "una migracion que reconstruye el objeto campo por campo pierde stage/imageSize/autoApprove " +
      "y el proyecto vuelve a correr videos o cambia de calidad sin que nadie lo pida.",
    { stage: "videos", autoApprove: false, imageSize: "2K", imageAspectRatio: "9:16", owner: "lucho" },
    {
      stage: v0.stage,
      autoApprove: v0.autoApprove,
      imageSize: v0.imageSize,
      imageAspectRatio: v0.imageAspectRatio,
      owner: v0.owner,
    },
  );

  // ─── 5. idempotente ───────────────────────────────────────────────────────
  const r5 = correr();
  const db5 = leer();
  afirmar(
    "5. correrlo dos veces no cambia nada",
    "si un deploy falla a mitad, el operador lo va a correr de nuevo sin saber si el primero " +
      "termino. La segunda corrida tiene que ser inofensiva.",
    { code: 0, mensaje: true, sigueIgual: true },
    {
      code: r5.code,
      mensaje: r5.stdout.includes("todos los proyectos ya tenian dueño"),
      sigueIgual: JSON.stringify(db5.projects) === JSON.stringify(db2.projects),
    },
  );

  // ─── 6. falta un nombre de Ivan → no escribe, sale 1 ──────────────────────
  const dbFalta = dbScratch();
  // Simula el error real: un caracter distinto al transcribir el nombre a mano.
  dbFalta.projects["ivan-0"].name = "AA_rendicion_meresigne_duena52_v20";
  escribirScratch(dbFalta);
  const antes6 = fs.readFileSync(dbPath, "utf8");
  const r6 = correr();
  afirmar(
    "6. si un nombre de Ivan no aparece, aborta sin escribir",
    "los 4 nombres se transcribieron a mano. Con un match silencioso, un proyecto de Ivan " +
      "termina siendo de Lucho y el script dice 'OK'.",
    { code: 1, archivoIgual: true },
    { code: r6.code, archivoIgual: antes6 === fs.readFileSync(dbPath, "utf8") },
  );

  // ─── 7. nombres duplicados → no escribe, sale 1 ───────────────────────────
  const dbDup = dbScratch();
  dbDup.projects["vid-0"].name = NOMBRES_IVAN[0]; // dos proyectos con el mismo nombre
  escribirScratch(dbDup);
  const antes7 = fs.readFileSync(dbPath, "utf8");
  const r7 = correr();
  afirmar(
    "7. si dos proyectos comparten el nombre de la lista, aborta sin escribir",
    "el matcheo es por nombre: con un duplicado no se puede saber cual es el de Ivan, y elegir " +
      "uno al azar le asigna a Ivan un proyecto de Lucho.",
    { code: 1, archivoIgual: true },
    { code: r7.code, archivoIgual: antes7 === fs.readFileSync(dbPath, "utf8") },
  );
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n${"─".repeat(60)}`);
if (fallos === 0) {
  console.log(`TODO EN VERDE (${ok}/${ok})`);
  process.exit(0);
}
console.log(`FALLOS: ${fallos} de ${ok + fallos}`);
process.exit(1);
