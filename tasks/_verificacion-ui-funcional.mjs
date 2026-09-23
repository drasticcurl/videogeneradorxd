#!/usr/bin/env node
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Verificacion 5 — la UI de verdad: los botones existen y nada se superpone.
 *
 *   node tasks/_verificacion-ui-funcional.mjs
 *
 * Salida esperada: "UI OK" y exit 0.
 *
 * ─── POR QUE EXISTE ──────────────────────────────────────────────────────────
 *
 * Dos bugs que ninguna de las otras cuatro verificaciones podia cazar, los dos
 * reportados por el usuario y no por un control:
 *
 *   1. (2026-09-23) "en mi laptop se superponen cosas": la seccion de imagenes del
 *      pipeline era `flex-none` con ~900px de contenido dentro de un contenedor de
 *      177px, y se dibujaba ENCIMA del log. Es geometria: no hay grep que lo vea.
 *
 *   2. (2026-09-23) "me desaparecio el boton de aprobar clip": el editor de clip
 *      quedo sin `onApprove` ni `onExtend` cuando el rediseño reemplazo las
 *      `JobCard` por lista + editor. El endpoint seguia vivo, el store seguia
 *      teniendo la accion y el typecheck pasaba: codigo muerto bien tipado.
 *
 * Las dos cosas solo se ven abriendo la app. Esto la abre.
 *
 * ─── COMO, SIN INSTALAR NADA ─────────────────────────────────────────────────
 *
 * Chrome ya esta en la maquina y Node 18+ trae `WebSocket` global, asi que se maneja
 * por CDP con ~40 lineas y cero dependencias. No hay Playwright ni Puppeteer que
 * mantener, y no hay un `node_modules` de 300MB para correr un chequeo.
 *
 * REQUISITOS: la app tiene que estar corriendo en `BASE` (default :3100) en
 * PROVIDER_MODE=mock, con un usuario cuya password este en `USUARIO`/`PASSWORD`.
 * Levantarla asi (desde la raiz del repo):
 *
 *   mkdir -p /tmp/gen-ui/{data,output}
 *   DATA_DIR=/tmp/gen-ui/data OUTPUT_DIR=/tmp/gen-ui/output PROVIDER_MODE=mock \
 *   AUTH_SECRET=0000000000000000000000000000000000000000000000000000000000000000 \
 *   PASSWORD_TEST=testtesttesttesttesttesttesttesttesttest \
 *   PIPELINE_AUTO_APPROVE=false npx next dev -p 3100
 *
 * NUNCA apuntarlo a produccion: siembra proyectos y aprueba jobs.
 *
 * Y NO CORRER `npm run build` MIENTRAS ESTE LEVANTADO: los dos escriben en `.next/`,
 * asi que el build le pisa los chunks al dev server y este script empieza a recibir
 * HTML de error donde espera JSON ("Unexpected token '<'"). Pasa, y el mensaje no
 * ayuda a entender por que. Reiniciar el dev server y volver a correr.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { spawn } from "node:child_process";

const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
const USUARIO = process.env.USUARIO ?? "test";
// 40 chars, que es el largo que usan las passwords reales del .env.production.
const PASSWORD = process.env.PASSWORD ?? "test".repeat(10);
const CHROME =
  process.env.CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PUERTO_CDP = 9333;

/** Los botones que TIENEN que existir en cada pantalla. Si falta uno, exit 1. */
const ESPERADOS = {
  "editor de clip (pipeline)": {
    // El clip se selecciona en awaiting_approval, asi que aprobar tiene que estar.
    presentes: ["Aprobar clip", "Guardar", "Guardar y regenerar", "Regenerar", "Extender +7s"],
    selector: "aside button",
  },
  "revisar clips (/batch/videos)": {
    presentes: ["Aprobar y seguir", "Regenerar", "Saltar"],
    selector: "button",
  },
};

const log = (...a) => console.log(...a);
let fallos = 0;

/* ─── 1. Sembrar: un proyecto de video en modo MANUAL con clips por aprobar ─── */
async function sembrar() {
  const r = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario: USUARIO, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`login ${r.status}: ¿esta la app en ${BASE} con PASSWORD_${USUARIO.toUpperCase()}?`);
  const cookie = (r.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";")[0])
    .join("; ");
  const H = { "Content-Type": "application/json", Cookie: cookie };

  const plan = {
    global: { idioma_dialogo: "es-AR", formato: "9:16", reglas_realismo: "doc", negative_prompt: "" },
    assets: [
      {
        id: "nat",
        tipo: "avatar",
        images: [{ id: "nat_base", modo: "text2image", prompt: "Doctor in clinic.", negative_prompt: "" }],
      },
    ],
    clips: [1, 2, 3].map((i) => ({
      id: `c${i}`, orden: i, asset_id: "nat", image_id: "nat_base",
      video_prompt: "She speaks to camera.", final_prompt: "",
      dialogo: `Clip ${i}.`, duracion_seg: 8, etiqueta: "IA",
      on_screen_text: "", resolucion: "720p",
    })),
    warnings: [],
  };

  const cr = await fetch(`${BASE}/api/projects`, {
    method: "POST", headers: H,
    body: JSON.stringify({ name: `verif-ui-${Date.now()}`, brief: "x", plan, imageVariants: 1, autoApprove: false }),
  });
  const pid = (await cr.json()).project.id;
  await fetch(`${BASE}/api/projects/${pid}/generate`, { method: "POST", headers: H });

  // La imagen base se aprueba a mano (modo manual) para que los videos arranquen.
  for (let i = 0; i < 40; i++) {
    await new Promise((s) => setTimeout(s, 1500));
    const jobs = (await (await fetch(`${BASE}/api/projects/${pid}/jobs`, { headers: H })).json()).jobs ?? [];
    const img = jobs.find((j) => j.type === "image" && j.status === "awaiting_approval");
    if (img) {
      await fetch(`${BASE}/api/jobs/${img.id}/approve`, {
        method: "POST", headers: H, body: JSON.stringify({ index: 0 }),
      });
    }
    if (jobs.some((j) => j.type === "video" && j.status === "awaiting_approval")) {
      return { pid, cookie };
    }
  }
  throw new Error("ningun video llego a awaiting_approval: ¿PIPELINE_AUTO_APPROVE quedo en true?");
}

/* ─── 2. Driver CDP minimo ──────────────────────────────────────────────────── */
async function abrirChrome() {
  const proc = spawn(
    CHROME,
    [
      "--headless=new", `--remote-debugging-port=${PUERTO_CDP}`,
      "--user-data-dir=/tmp/gen-ui/chrome-verif", "--no-first-run",
      "--no-default-browser-check", "--hide-scrollbars", "about:blank",
    ],
    { stdio: "ignore", detached: false },
  );
  for (let i = 0; i < 30; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${PUERTO_CDP}/json/version`)).json();
      return { proc, wsUrl: v.webSocketDebuggerUrl };
    } catch { await new Promise((s) => setTimeout(s, 500)); }
  }
  throw new Error(`Chrome no abrio. ¿Existe ${CHROME}? Se puede pasar otro con CHROME=`);
}

async function conectar(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pend = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((res, rej) => {
      const n = ++id;
      pend.set(n, (m) => (m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result)));
      ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S("Page.enable"); await S("Runtime.enable"); await S("Network.enable");
  return { ws, S };
}

/** Lo que corre adentro del navegador: desborde sin scroll + cajas superpuestas. */
const DIAG = `(() => {
  const vh = innerHeight, vw = innerWidth, out = { desborda: [], superpuestos: [] };
  const desc = (el) => {
    const c = (typeof el.className === "string" ? el.className : "").split(/\\s+/).slice(0,3).join(".");
    return el.tagName.toLowerCase() + (c ? "." + c : "") + ' "' + (el.textContent||"").trim().replace(/\\s+/g," ").slice(0,32) + '"';
  };
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || getComputedStyle(el).position === "fixed") continue;
    const abajo = r.bottom > vh + 1, der = r.right > vw + 1;
    if (!abajo && !der) continue;
    let scrolleable = false;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p);
      if ((abajo && /auto|scroll/.test(o.overflowY)) || (der && /auto|scroll/.test(o.overflowX))) { scrolleable = true; break; }
    }
    if (!scrolleable) out.desborda.push(desc(el) + "  +" + Math.round(abajo ? r.bottom - vh : r.right - vw) + "px");
  }
  const cajas = [...document.querySelectorAll("main *")].filter((el) => {
    const r = el.getBoundingClientRect(), o = getComputedStyle(el);
    return r.width > 24 && r.height > 12 && o.position !== "absolute" && o.position !== "fixed" && o.display !== "inline";
  });
  for (const el of cajas) {
    const a = el.getBoundingClientRect();
    for (const h of [...(el.parentElement?.children ?? [])]) {
      if (h === el || !cajas.includes(h)) continue;
      const b = h.getBoundingClientRect();
      const ox = Math.min(a.right,b.right) - Math.max(a.left,b.left);
      const oy = Math.min(a.bottom,b.bottom) - Math.max(a.top,b.top);
      if (ox > 4 && oy > 4) {
        const k = desc(el) + " ⟷ " + desc(h);
        if (!out.superpuestos.includes(k)) out.superpuestos.push(k);
      }
    }
  }
  out.desborda = out.desborda.slice(0,8); out.superpuestos = out.superpuestos.slice(0,8);
  return JSON.stringify(out);
})()`;

const botonesDe = (selector) => `(() => JSON.stringify(
  [...document.querySelectorAll(${JSON.stringify(selector)})]
    .map(b => (b.textContent||"").replace(/\\s+/g," ").trim()).filter(Boolean)
))()`;

/* ─── 3. El chequeo ─────────────────────────────────────────────────────────── */
async function main() {
  log("sembrando un proyecto de video en modo manual…");
  const { pid, cookie } = await sembrar();
  const token = cookie.replace(/^gen_session=/, "");
  log(`  proyecto ${pid}\n`);

  const { proc, wsUrl } = await abrirChrome();
  const { ws, S } = await conectar(wsUrl);
  await S("Network.setCookie", { name: "gen_session", value: token, domain: "127.0.0.1", path: "/" });

  const ir = async (url, ms = 6000) => {
    await S("Page.navigate", { url });
    await new Promise((s) => setTimeout(s, ms));
  };
  const evaluar = async (expr) => {
    const { result } = await S("Runtime.evaluate", { expression: expr, returnByValue: true });
    return result.value;
  };

  // ── 3a. Layout, en los tamaños de laptop donde aparecio el bug ──
  log("═══ layout: nada desborda sin scroll, nada se superpone ═══");
  for (const [w, h] of [[1440, 820], [1366, 660], [1280, 700]]) {
    await S("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    for (const [nombre, url] of [
      ["pipeline", `${BASE}/project/${pid}/pipeline`],
      ["result", `${BASE}/project/${pid}/result`],
      ["revisar", `${BASE}/batch/videos?ids=${pid}`],
      ["imagenes", `${BASE}/imagenes`],
      ["home", `${BASE}/`],
      ["tablero", `${BASE}/batch?ids=${pid}`],
    ]) {
      await ir(url, 4000);
      const d = JSON.parse(await evaluar(DIAG));
      const mal = d.desborda.length + d.superpuestos.length;
      if (mal === 0) {
        log(`  OK    ${nombre} @ ${w}x${h}`);
      } else {
        log(`  MAL   ${nombre} @ ${w}x${h}`);
        d.desborda.forEach((x) => log(`          desborda: ${x}`));
        d.superpuestos.forEach((x) => log(`          se pisan: ${x}`));
        fallos++;
      }
    }
  }

  // ── 3b. Los botones que no pueden faltar ──
  log("\n═══ botones que tienen que estar ═══");
  await S("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  await ir(`${BASE}/project/${pid}/pipeline`);
  // Seleccionar el primer clip que espera aprobacion.
  await evaluar(`(() => {
    const f = [...document.querySelectorAll("tbody tr")].find(tr => /Elegí variante/.test(tr.textContent||""));
    (f ?? document.querySelector("tbody tr"))?.click();
    return 1;
  })()`);
  await new Promise((s) => setTimeout(s, 2500));
  await chequear("editor de clip (pipeline)", evaluar);

  await ir(`${BASE}/batch/videos?ids=${pid}`);
  await chequear("revisar clips (/batch/videos)", evaluar);

  ws.close();
  proc.kill();

  log("");
  if (fallos > 0) {
    log(`FALLOS: ${fallos}`);
    process.exit(1);
  }
  log("UI OK");
}

async function chequear(pantalla, evaluar) {
  const { presentes, selector } = ESPERADOS[pantalla];
  const encontrados = JSON.parse(await evaluar(botonesDe(selector)));
  const faltan = presentes.filter((p) => !encontrados.some((e) => e.includes(p)));
  if (faltan.length === 0) {
    log(`  OK    ${pantalla}: ${presentes.length} botones`);
  } else {
    log(`  MAL   ${pantalla}: FALTAN ${faltan.map((f) => `"${f}"`).join(", ")}`);
    log(`          los que hay: ${encontrados.join(" · ")}`);
    fallos++;
  }
}

main().catch((e) => {
  console.error("\nno se pudo verificar:", e.message);
  process.exit(2);
});
