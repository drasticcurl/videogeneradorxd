/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Verificacion 4 de 4 — que `cn()` no se coma clases.
 *
 *   node tasks/_verificacion-cn.mjs
 *
 * Salida esperada: "FALLOS: 0" y exit 0.
 *
 * ─── POR QUE EXISTE ──────────────────────────────────────────────────────────
 *
 * Nacio de un bug real de T01, encontrado por los dos agentes de la ola 2 por
 * separado. `tailwind-merge` NO lee tailwind.config.ts, asi que la escala
 * tipografica con nombres propios de este proyecto (label/body/title/display) le
 * caia en el grupo `text-color` en lugar de `font-size`. Resultado: cualquier
 * string que mezclara un tamaño con un color perdia uno de los dos, en silencio.
 *
 * El caso peor era `Button variant="primary"` (`bg-fg text-bg`): perdia el
 * `text-bg`, heredaba `fg` y quedaba texto casi blanco sobre fondo casi blanco. Un
 * boton INVISIBLE que compila, pasa el typecheck y pasa el build.
 *
 * Es exactamente la clase de falla que este modulo tiene que atajar, asi que
 * queda con un comando propio: si alguien agrega un tamaño a `fontSize` y se
 * olvida de declararlo en `src/lib/cn.ts`, esto falla en vez de dejar botones
 * invisibles sueltos por la app.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";
import { extendTailwindMerge } from "tailwind-merge";

// ─── Se reconstruye el mismo merge que usa src/lib/cn.ts ───────────────────
// No se importa `cn` directamente porque es TypeScript y este script corre con node
// pelado, sin build. La lista de tamaños se LEE del archivo, asi que si alguien
// agrega uno alla y no aca, el chequeo de sincronia de mas abajo lo caza.
const fuenteCn = readFileSync(new URL("../src/lib/cn.ts", import.meta.url), "utf8");
const declarados = [
  ...fuenteCn.matchAll(/TAMANIOS_DE_TEXTO\s*=\s*\[([^\]]+)\]/g),
]
  .flatMap((m) => m[1].split(","))
  .map((s) => s.trim().replace(/['"]/g, ""))
  .filter(Boolean);

const twMerge = extendTailwindMerge({
  extend: { classGroups: { "font-size": [{ text: declarados }] } },
});

// ─── Los tamaños que el config declara de verdad ───────────────────────────
const fuenteConfig = readFileSync(
  new URL("../tailwind.config.ts", import.meta.url),
  "utf8",
);
const bloqueFontSize = /fontSize:\s*\{([\s\S]*?)\n {6}\}/.exec(fuenteConfig);
const enConfig = bloqueFontSize
  ? [...bloqueFontSize[1].matchAll(/^\s{8}([a-z]+):/gm)].map((m) => m[1])
  : [];

console.log("═".repeat(72));
console.log("cn() — que no se coma tamaños ni colores");
console.log("═".repeat(72));
console.log();
console.log("  tamaños en tailwind.config.ts :", enConfig.join(", ") || "(no se pudo leer)");
console.log("  tamaños declarados en cn.ts   :", declarados.join(", "));

let fallos = 0;

// ─── 1. Sincronia entre el config y cn.ts ──────────────────────────────────
const faltantes = enConfig.filter((t) => !declarados.includes(t));
if (faltantes.length > 0) {
  fallos++;
  console.log();
  console.log(`  FALLA  estos tamaños estan en el config y NO en cn.ts: ${faltantes.join(", ")}`);
  console.log("         cn() los va a tratar como COLOR de texto y va a comerse uno de los dos.");
} else if (enConfig.length > 0) {
  console.log();
  console.log("  OK     cn.ts declara todos los tamaños del config");
}

// ─── 2. Los pares que la UI usa de verdad ──────────────────────────────────
// `debe` = las clases que TIENEN que sobrevivir. `noDebe` = las que no.
const CASOS = [
  {
    desc: "tamaño + color (lo que hace Badge)",
    entrada: ["text-label", "text-fg-dim"],
    debe: ["text-label", "text-fg-dim"],
  },
  {
    desc: "primario de Button + tamaño del llamador",
    entrada: ["bg-fg text-bg", "text-label"],
    debe: ["bg-fg", "text-bg", "text-label"],
  },
  {
    desc: "ghost de Button + tamaño",
    entrada: ["text-fg-dim hover:text-fg", "text-body"],
    debe: ["text-fg-dim", "hover:text-fg", "text-body"],
  },
  {
    desc: "mono + tamaño + color, los tres juntos",
    entrada: ["font-mono text-label text-fg"],
    debe: ["font-mono", "text-label", "text-fg"],
  },
  {
    desc: "dos tamaños SI tienen que colapsar (conflicto real)",
    entrada: ["text-label", "text-title"],
    debe: ["text-title"],
    noDebe: ["text-label"],
  },
  {
    desc: "dos colores SI tienen que colapsar (conflicto real)",
    entrada: ["text-fg-dim", "text-accent"],
    debe: ["text-accent"],
    noDebe: ["text-fg-dim"],
  },
  {
    desc: "padding sigue colapsando como siempre",
    entrada: ["p-2", "p-4"],
    debe: ["p-4"],
    noDebe: ["p-2"],
  },
];

console.log();
for (const c of CASOS) {
  const salida = twMerge(...c.entrada);
  const clases = salida.split(/\s+/).filter(Boolean);
  const perdidas = c.debe.filter((d) => !clases.includes(d));
  const colados = (c.noDebe ?? []).filter((n) => clases.includes(n));
  const ok = perdidas.length === 0 && colados.length === 0;
  if (!ok) fallos++;
  console.log(`  ${ok ? "OK   " : "FALLA"} ${c.desc}`);
  console.log(`         "${c.entrada.join(" ")}"  ->  "${salida}"`);
  if (perdidas.length) console.log(`         PERDIO: ${perdidas.join(", ")}`);
  if (colados.length) console.log(`         NO COLAPSO: ${colados.join(", ")}`);
}

console.log();
console.log("═".repeat(72));
console.log(`FALLOS: ${fallos}`);
process.exit(fallos === 0 ? 0 : 1);
