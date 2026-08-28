/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Verificacion 2 de 3 — contraste WCAG de la paleta.
 *
 * Corrida y en verde el 2026-08-28: 0 fallos.
 *
 *   node tasks/_verificacion-contraste.mjs
 *
 * Salida esperada: "FALLOS: 0" y exit 0.
 *
 * POR QUE ES UN ARCHIVO Y NO UNA TABLA EN EL PLAN: cada pantalla va a elegir
 * combinaciones de tokens, y la unica forma de que cinco agentes no inventen un
 * gris ilegible cada uno es que exista un comando que falle. Si una task agrega
 * un par nuevo, lo agrega ACA primero.
 *
 * Dos cosas que esta verificacion descubrio y que estaban mal en el borrador del
 * plan, para que nadie las "arregle" de vuelta:
 *
 *   1. zinc-500 como texto NO pasa (4.12:1 sobre el fondo, 3.67:1 sobre la
 *      superficie). El texto mas apagado que se puede usar es zinc-400.
 *   2. zinc-600/700/800 como borde de un componente INTERACTIVO no pasan el 3:1
 *      que pide WCAG 1.4.11. El minimo es zinc-500. De ahi salen DOS tokens de
 *      borde distintos: `border` (interactivo) y `divider` (decorativo, que no
 *      necesita pasar porque no es un componente).
 *
 * De paso deja el numero que justifica cambiar el acento: el indigo-500 que usa
 * la app hoy NO pasa AA en ninguno de los dos sentidos.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const C = {
  "zinc-950": "#09090b",
  "zinc-900": "#18181b",
  "zinc-800": "#27272a",
  "zinc-500": "#71717a",
  "zinc-400": "#a1a1aa",
  "zinc-50": "#fafafa",
  "amber-400": "#fbbf24",
  "emerald-400": "#34d399",
  "rose-400": "#fb7185",
  "sky-400": "#38bdf8",
  "indigo-500": "#6366f1",
};

/** Luminancia relativa segun WCAG 2.1. */
function luminancia(hex) {
  const h = hex.replace("#", "");
  const canales = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * canales[0] + 0.7152 * canales[1] + 0.0722 * canales[2];
}

function contraste(a, b) {
  const la = luminancia(a);
  const lb = luminancia(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const FONDO = C["zinc-950"];
const SUPERFICIE = C["zinc-900"];

/**
 * Cada par que la UI usa de verdad. `min` es 4.5 para texto normal y 3.0 para
 * componentes y objetos graficos (WCAG 1.4.11).
 */
const PARES = [
  ["texto principal sobre fondo", C["zinc-50"], FONDO, 4.5],
  ["texto principal sobre superficie", C["zinc-50"], SUPERFICIE, 4.5],
  ["texto apagado sobre fondo", C["zinc-400"], FONDO, 4.5],
  ["texto apagado sobre superficie", C["zinc-400"], SUPERFICIE, 4.5],
  ["borde interactivo sobre fondo", C["zinc-500"], FONDO, 3.0],
  ["borde interactivo sobre superficie", C["zinc-500"], SUPERFICIE, 3.0],
  ["anillo de foco", C["amber-400"], FONDO, 3.0],
  ["acento como texto", C["amber-400"], FONDO, 4.5],
  ["texto sobre boton de acento", FONDO, C["amber-400"], 4.5],
  ["boton primario (texto sobre claro)", FONDO, C["zinc-50"], 4.5],
  ["estado done", C["emerald-400"], SUPERFICIE, 4.5],
  ["estado failed", C["rose-400"], SUPERFICIE, 4.5],
  ["estado generating", C["sky-400"], SUPERFICIE, 4.5],
  ["estado awaiting (usa el acento)", C["amber-400"], SUPERFICIE, 4.5],
  ["estado pending", C["zinc-400"], SUPERFICIE, 4.5],
];

console.log("═".repeat(72));
console.log("PALETA DEL REDISEÑO — contraste WCAG");
console.log("═".repeat(72));

let fallos = 0;
for (const [desc, fg, bg, min] of PARES) {
  const r = contraste(fg, bg);
  const ok = r >= min;
  if (!ok) fallos++;
  console.log(
    `  ${ok ? "OK   " : "FALLA"} ${desc.padEnd(36)} ${r.toFixed(2).padStart(5)}:1  (min ${min})`,
  );
}

console.log();
console.log("─".repeat(72));
console.log("Referencia: el acento que la app usa HOY (indigo-500)");
console.log("─".repeat(72));
for (const [desc, fg, bg] of [
  ["indigo-500 como texto sobre fondo", C["indigo-500"], FONDO],
  ["texto claro sobre boton indigo", C["zinc-50"], C["indigo-500"]],
]) {
  const r = contraste(fg, bg);
  console.log(
    `  ${r >= 4.5 ? "OK   " : "FALLA"} ${desc.padEnd(36)} ${r.toFixed(2).padStart(5)}:1  (min 4.5)`,
  );
}

console.log();
console.log("─".repeat(72));
console.log("Divisor decorativo: zinc-800 da 1.34:1 y NO tiene que pasar 3:1.");
console.log("WCAG 1.4.11 aplica a componentes interactivos y objetos graficos,");
console.log("no a separadores. Por eso `border` y `divider` son tokens distintos.");
console.log("─".repeat(72));
console.log();
console.log(`FALLOS: ${fallos}`);

process.exit(fallos === 0 ? 0 : 1);
