#!/usr/bin/env node
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Verificacion de punta a punta del CAMBIO DE VOZ, en mock, adentro de la app.
 *
 *   node tasks/cambio-de-voz/_verificacion-voz-mock.mjs
 *
 * Salida esperada: "VOZ OK (mock)" y exit 0. Si algo falla: "FALLOS: N" y exit 1.
 *
 * ─── POR QUE EXISTE ──────────────────────────────────────────────────────────
 *
 * Casi todo lo que puede salir mal en este modulo compila y pasa los chequeos
 * estaticos: un tramo corrido, un clip conservado que se convirtio igual, un DELETE
 * que borra la carpeta antes de cancelar y la corrida la recrea, un 409 que no llega.
 * Esto levanta la app de verdad, siembra un proyecto, une, convierte y mira los
 * archivos con ffmpeg. Son los 14 casos de tasks/cambio-de-voz/T07 §3.
 *
 * ─── REQUISITOS ──────────────────────────────────────────────────────────────
 *
 * Mismo patron que tasks/_verificacion-ui-funcional.mjs: sin dependencias, la app
 * levantada en `BASE` (default :3100), en mock. Levantarla asi (desde la raiz):
 *
 *   mkdir -p /tmp/gen-ui/{data,output}
 *   DATA_DIR=/tmp/gen-ui/data OUTPUT_DIR=/tmp/gen-ui/output PROVIDER_MODE=mock \
 *   AUTH_SECRET=0000000000000000000000000000000000000000000000000000000000000000 \
 *   PASSWORD_TEST=testtesttesttesttesttesttesttesttesttest \
 *   PASSWORD_OTRO=otrootrootrootrootrootrootrootrootrootro \
 *   VOICE_PROVIDER=mock VOICE_MOCK_DELAY_MS=1500 PIPELINE_AUTO_APPROVE=true \
 *   npx next dev -p 3100
 *
 * El segundo usuario (`otro`) es para el caso 11 (aislamiento). `ffmpeg`, `ffprobe` y
 * `unzip` tienen que estar en el PATH: se usan para mirar los archivos. `OUTPUT_DIR`
 * tiene que ser el mismo que el de la app (default /tmp/gen-ui/output).
 *
 * NUNCA apuntarlo a produccion: siembra, convierte y BORRA un proyecto.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? "/tmp/gen-ui/output";
const USUARIOS = {
  test: process.env.PASSWORD ?? "test".repeat(10),
  otro: process.env.PASSWORD_OTRO ?? "otro".repeat(10),
};
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "voz-e2e-"));

const log = (...a) => console.log(...a);
const espera = (ms) => new Promise((s) => setTimeout(s, ms));
let fallos = 0;

function afirmar(caso, cond, esperado, real) {
  if (cond) {
    log(`  OK    ${caso}`);
  } else {
    log(`  MAL   ${caso}`);
    log(`          esperado: ${esperado}`);
    log(`          real:     ${real}`);
    fallos++;
  }
  return cond;
}

/* ─── HTTP ─── */
async function login(usuario) {
  const r = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario, password: USUARIOS[usuario] }),
  });
  if (!r.ok) throw new Error(`login ${usuario} ${r.status}: ¿esta la app en ${BASE} con PASSWORD_${usuario.toUpperCase()}?`);
  return (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
}

function cliente(cookie) {
  const pedir = async (metodo, url, body) => {
    const init = { method: metodo, headers: cookie ? { Cookie: cookie } : {} };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const r = await fetch(`${BASE}${url}`, init);
    const texto = await r.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { /* no-JSON */ }
    return { status: r.status, json, texto };
  };
  return {
    get: (u) => pedir("GET", u),
    post: (u, b) => pedir("POST", u, b ?? {}),
    del: (u) => pedir("DELETE", u),
    bajar: async (u, destino) => {
      const r = await fetch(`${BASE}${u}`, { headers: cookie ? { Cookie: cookie } : {} });
      fs.writeFileSync(destino, Buffer.from(await r.arrayBuffer()));
      return r.status;
    },
  };
}

/* ─── ffmpeg ─── */
function ff(args) {
  const r = spawnSync("ffmpeg", ["-hide_banner", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return r;
}
function duracion(file) {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" });
  return Number(r.stdout.trim());
}
function md5Video(file) {
  return ff(["-v", "error", "-i", file, "-map", "0:v", "-c", "copy", "-f", "md5", "-"]).stdout.trim();
}
/** Muestras del audio decodificado a 48 kHz (duration_ts de un WAV). */
function muestras(file) {
  const wav = path.join(TMP, `m_${path.basename(file)}.wav`);
  ff(["-v", "error", "-y", "-i", file, "-vn", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", wav]);
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=duration_ts", "-of", "csv=p=0", wav], { encoding: "utf8" });
  return Number(r.stdout.trim());
}
/**
 * Energia (dB) de una banda de frecuencia en un intervalo: bandpass doble y
 * volumedetect. Se comparan bandas ENTRE SI en el mismo intervalo, no contra un umbral
 * absoluto: el audio conservado pasa otra vez por AAC y el nivel cambia un poco.
 */
function energia(file, desde, hasta, hz) {
  const r = ff([
    "-v", "info", "-ss", String(desde), "-t", String(hasta - desde), "-i", file, "-vn",
    "-af", `bandpass=f=${hz}:width_type=h:w=20,bandpass=f=${hz}:width_type=h:w=20,volumedetect`,
    "-f", "null", "-",
  ]);
  const m = /mean_volume: (-?[\d.]+) dB/.exec(r.stderr);
  return m ? Number(m[1]) : -120;
}

/* ─── esperas ─── */
async function hasta(fn, { ms = 90000, cada = 500, que = "la condicion" } = {}) {
  const fin = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > fin) throw new Error(`timeout esperando ${que}`);
    await espera(cada);
  }
}
const version = async (A, pid, id) => (await A.get(`/api/projects/${pid}/voz`)).json?.versiones?.find((v) => v.id === id);
const terminada = (A, pid, id) =>
  hasta(async () => {
    const v = await version(A, pid, id);
    return v && ["lista", "fallida", "cancelada"].includes(v.estado) ? v : null;
  }, { que: `la version ${id}` });

/* ─── siembra ─── */
async function sembrar(A) {
  const plan = {
    global: { idioma_dialogo: "es-AR", formato: "9:16", reglas_realismo: "doc", negative_prompt: "" },
    assets: [{ id: "nat", tipo: "avatar", images: [{ id: "nat_base", modo: "text2image", prompt: "Doctor in clinic.", negative_prompt: "" }] }],
    clips: [
      { id: "c1", orden: 1, etiqueta: "IA", dialogo: "Hola, soy la doctora.", duracion_seg: 8 },
      { id: "c2", orden: 2, etiqueta: "IA", dialogo: "Hoy te cuento algo.", duracion_seg: 8 },
      { id: "c3", orden: 3, etiqueta: "FILMAR_REAL", dialogo: "Esto lo grabé yo.", duracion_seg: 6 },
      { id: "c4", orden: 4, etiqueta: "IA", dialogo: "", duracion_seg: 8 },
    ].map((c) => ({ ...c, asset_id: "nat", image_id: "nat_base", video_prompt: "She speaks.", final_prompt: "", on_screen_text: "", resolucion: "720p" })),
    warnings: [],
  };
  const cr = await A.post("/api/projects", { name: `verif-voz-${Date.now()}`, brief: "x", plan, imageVariants: 1, autoApprove: true });
  const pid = cr.json?.project?.id;
  if (!pid) throw new Error(`no se pudo crear el proyecto: ${cr.status} ${cr.texto.slice(0, 200)}`);

  // c3 filmado: un mp4 con tono de 660 Hz, para reconocerlo despues en la version.
  const c3 = path.join(TMP, "c3.mp4");
  ff(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=720x1280:r=24:d=6", "-f", "lavfi", "-i", "sine=f=660:r=48000:d=6",
    "-map", "0", "-map", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", "-shortest", c3]);
  const fd = new FormData();
  fd.append("clipId", "c3");
  fd.append("file", new Blob([fs.readFileSync(c3)], { type: "video/mp4" }), "c3.mp4");
  const up = await A.post(`/api/projects/${pid}/upload`, fd);
  if (up.status !== 200) throw new Error(`upload c3: ${up.status} ${up.texto.slice(0, 200)}`);

  await A.post(`/api/projects/${pid}/generate`);
  await hasta(async () => {
    const jobs = (await A.get(`/api/projects/${pid}/jobs`)).json?.jobs ?? [];
    const videos = jobs.filter((j) => j.type === "video");
    return videos.length === 3 && videos.every((j) => j.status === "done");
  }, { ms: 180000, cada: 1500, que: "los 3 clips IA en done" });
  return pid;
}

const POST_VOZ = (accion, extra = {}) => ({
  accion,
  voz: { id: "mock-aguda", nombre: "Aguda (mock)" },
  ajustes: null,
  quitarRuido: true,
  incluirFilmados: false,
  ...extra,
});

/* ─── los 14 casos ─── */
async function main() {
  const A = cliente(await login("test"));
  const O = cliente(await login("otro"));
  const anon = cliente(null);

  log("sembrando un proyecto de 4 clips (c1 c2 IA con dialogo, c3 filmado, c4 IA sin dialogo)…");
  const pid = await sembrar(A);
  const dir = path.join(OUTPUT_DIR, pid);
  log(`  proyecto ${pid}\n`);

  // 1 — Unir
  log("═══ 1. unir ═══");
  const st = await A.post(`/api/projects/${pid}/stitch`);
  const unidoRel = st.json?.finalPath;
  const unido = path.join(dir, unidoRel ?? "x");
  afirmar("stitch ok", st.json?.ok === true, "ok: true", JSON.stringify(st.json));
  const proj = (await A.get(`/api/projects/${pid}`)).json?.project;
  const receta = proj?.recetaUnido;
  const contiguos = receta?.clips?.every((c, i, a) => i === 0 || Math.abs(a[i - 1].finSeg - c.inicioSeg) < 1e-9);
  afirmar("receta con 4 clips contiguos", receta?.clips?.length === 4 && contiguos, "4 clips, fin(i) == inicio(i+1)",
    JSON.stringify(receta?.clips?.map((c) => [c.id, c.inicioSeg, c.finSeg])));
  const durUnido = duracion(unido);
  afirmar("duracionSeg ≈ ffprobe del unido (±0,1)", Math.abs((receta?.duracionSeg ?? 0) - durUnido) <= 0.1, durUnido, receta?.duracionSeg);
  const [r1, r2, r3, r4] = receta.clips;

  // 2 — Estado
  log("\n═══ 2. estado ═══");
  let e = (await A.get(`/api/projects/${pid}/voz`)).json;
  afirmar("GET /voz", e?.unido?.conReceta === true && e?.unido?.desactualizado === false && e?.filmadosConDialogo === 1 && e?.activa === null && e?.proveedor === "mock",
    "conReceta, !desactualizado, 1 filmado, sin activa, mock",
    JSON.stringify({ conReceta: e?.unido?.conReceta, des: e?.unido?.desactualizado, f: e?.filmadosConDialogo, activa: e?.activa, p: e?.proveedor }));

  // 3 — Estimacion
  log("\n═══ 3. estimacion ═══");
  const sin = e.estimacion?.sinFilmados, con = e.estimacion?.conFilmados;
  afirmar("sinFilmados ≈ c1+c2", Math.abs(sin?.segundos - r2.finSeg) <= 0.1 && sin?.tramos === 1, `${r2.finSeg}s / 1 tramo`, `${sin?.segundos}s / ${sin?.tramos}`);
  afirmar("conFilmados ≈ c1+c2+c3", Math.abs(con?.segundos - r3.finSeg) <= 0.1 && con?.tramos === 1, `${r3.finSeg}s / 1 tramo`, `${con?.segundos}s / ${con?.tramos}`);

  // 4 — Prueba
  log("\n═══ 4. prueba de 20 s ═══");
  const pr = await A.post(`/api/projects/${pid}/voz`, POST_VOZ("probar"));
  afirmar("POST probar → 202", pr.status === 202, 202, `${pr.status} ${pr.texto.slice(0, 150)}`);
  const vp = await terminada(A, pid, pr.json?.version?.id);
  const archPrueba = vp?.file ? path.join(dir, vp.file) : "";
  afirmar("prueba lista y en disco", vp?.estado === "lista" && fs.existsSync(archPrueba), "lista + archivo", `${vp?.estado} ${vp?.error ?? ""}`);
  const durPrueba = archPrueba ? duracion(archPrueba) : 0;
  afirmar("dura min(20, …) ±0,1", Math.abs(durPrueba - Math.min(20, durUnido)) <= 0.1, Math.min(20, durUnido), durPrueba);

  // 5 — Conversion + 409
  log("\n═══ 5. conversion completa + 409 al unir ═══");
  const cv = await A.post(`/api/projects/${pid}/voz`, POST_VOZ("convertir"));
  afirmar("POST convertir → 202", cv.status === 202, 202, `${cv.status} ${cv.texto.slice(0, 150)}`);
  const st409 = await A.post(`/api/projects/${pid}/stitch`);
  afirmar("stitch con conversion viva → 409 con reason", st409.status === 409 && Boolean(st409.json?.reason), "409 + reason", `${st409.status} ${JSON.stringify(st409.json)}`);
  const vc = await terminada(A, pid, cv.json?.version?.id);
  afirmar("version lista", vc?.estado === "lista", "lista", `${vc?.estado} ${vc?.error ?? ""}`);

  // 6 — El resultado
  log("\n═══ 6. el resultado ═══");
  const bajada = path.join(TMP, "version.mp4");
  await A.bajar(`/api/files/${pid}/${vc.file}`, bajada);
  const durV = duracion(bajada);
  afirmar("misma duracion que el unido (±0,05)", Math.abs(durV - durUnido) <= 0.05, durUnido, durV);
  const md5U = md5Video(unido), md5V = md5Video(bajada);
  afirmar("md5 del stream de video identico", md5U && md5U === md5V, md5U, md5V);
  const mU = muestras(unido), mV = muestras(bajada);
  afirmar("mismas muestras de audio (±1024)", Math.abs(mU - mV) <= 1024, mU, mV);
  // Por tono, con margen de 0,3 s en cada borde (el AAC y el filtro corren los flancos).
  const tramo = (c) => [c.inicioSeg + 0.3, c.finSeg - 0.3];
  const banda = (c, hz) => energia(bajada, ...tramo(c), hz);
  for (const c of [r1, r2]) {
    const e275 = banda(c, 275), e220 = banda(c, 220);
    afirmar(`${c.id} convertido: suena 275 Hz, no 220`, e275 > e220 + 10, "275 > 220 + 10 dB", `275: ${e275} dB · 220: ${e220} dB`);
  }
  {
    const e660 = banda(r3, 660), e275 = banda(r3, 275), e220 = banda(r3, 220);
    afirmar("c3 filmado conservado: suena 660 Hz", e660 > e275 + 10 && e660 > e220 + 10, "660 > 275 y 220 (+10 dB)", `660: ${e660} · 275: ${e275} · 220: ${e220}`);
  }
  {
    const e220 = banda(r4, 220), e275 = banda(r4, 275);
    afirmar("c4 sin dialogo conservado: suena 220 Hz, no 275", e220 > e275 + 10, "220 > 275 + 10 dB", `220: ${e220} dB · 275: ${e275} dB`);
  }

  // 7 — Cancelar
  log("\n═══ 7. cancelar ═══");
  const cc = await A.post(`/api/projects/${pid}/voz`, POST_VOZ("convertir", { voz: { id: "mock-grave", nombre: "Grave (mock)" } }));
  const can = await A.post(`/api/projects/${pid}/voz`, { accion: "cancelar" });
  afirmar("cancelar → cancelada: true", can.json?.cancelada === true, true, JSON.stringify(can.json));
  await espera(2500);
  const vx = await version(A, pid, cc.json?.version?.id);
  afirmar("version cancelada y sin archivo", vx?.estado === "cancelada" && !vx?.file, "cancelada, file null", `${vx?.estado} ${vx?.file}`);
  afirmar("no queda voz/_trabajo/", !fs.existsSync(path.join(dir, "voz", "_trabajo")), "no existe", "existe");

  // 9 — Zip (antes del 8: el zip se mira con la version completa vigente)
  log("\n═══ 9. zip ═══");
  const zip = path.join(TMP, "todo.zip");
  await A.bajar(`/api/projects/${pid}/download`, zip);
  const lista = spawnSync("unzip", ["-l", zip], { encoding: "utf8" }).stdout;
  afirmar("el zip trae la version completa", lista.includes(path.basename(vc.file)), path.basename(vc.file), lista.split("\n").filter((l) => l.includes(".mp4")).map((l) => l.trim().split(/\s+/).pop()).join(" "));
  afirmar("el zip NO trae la prueba", !lista.includes(path.basename(vp.file)), `sin ${path.basename(vp.file)}`, "la trae");

  // 8 — Desactualizado
  log("\n═══ 8. unido desactualizado ═══");
  const jobsAntes = (await A.get(`/api/projects/${pid}/jobs`)).json?.jobs ?? [];
  const j2 = jobsAntes.find((j) => j.type === "video" && j.refId === "c2");
  await A.post(`/api/jobs/${encodeURIComponent(j2.id)}/retry`);
  /*
    Se espera a que c2 TERMINE de regenerarse. Mientras regenera, el clip no tiene
    archivo y el motivo es "Se sacaron clips" (verdad en ese momento, pero no es el
    caso que se prueba): primero sale de done, despues vuelve.
  */
  await hasta(async () => {
    const js = (await A.get(`/api/projects/${pid}/jobs`)).json?.jobs ?? [];
    return js.find((x) => x.id === j2.id)?.status !== "done";
  }, { ms: 30000, cada: 200, que: "que c2 empiece a regenerarse" });
  await hasta(async () => {
    const js = (await A.get(`/api/projects/${pid}/jobs`)).json?.jobs ?? [];
    return js.find((x) => x.id === j2.id)?.status === "done";
  }, { ms: 120000, cada: 1000, que: "c2 regenerado en done" });
  e = (await A.get(`/api/projects/${pid}/voz`)).json;
  afirmar("desactualizado, con motivo del clip 02", e?.unido?.desactualizado === true && /02/.test(e?.unido?.motivo ?? ""), "motivo con 02", e?.unido?.motivo);
  const des = await A.post(`/api/projects/${pid}/voz`, POST_VOZ("convertir"));
  afirmar("convertir → 400 desactualizado", des.status === 400 && des.json?.codigo === "desactualizado", "400 desactualizado", `${des.status} ${JSON.stringify(des.json)}`);
  const st2 = await A.post(`/api/projects/${pid}/stitch`);
  afirmar("volver a unir → ok", st2.json?.ok === true, "ok", JSON.stringify(st2.json).slice(0, 200));
  e = (await A.get(`/api/projects/${pid}/voz`)).json;
  afirmar("ya no esta desactualizado", e?.unido?.desactualizado === false, false, e?.unido?.desactualizado);
  const viejas = e.versiones.filter((v) => v.estado === "lista");
  afirmar("las versiones viejas tienen otra recetaCreadaEn", viejas.length > 0 && viejas.every((v) => v.recetaCreadaEn !== e.unido.creadoEn),
    "todas != creadoEn nuevo", JSON.stringify(viejas.map((v) => v.recetaCreadaEn)) + " vs " + e.unido.creadoEn);

  // 10 — Borrar version
  log("\n═══ 10. borrar version ═══");
  const bor = await A.del(`/api/projects/${pid}/voz?version=${vc.id}`);
  afirmar("DELETE version → 200", bor.status === 200 && bor.json?.borrada === true, 200, `${bor.status} ${bor.texto.slice(0, 100)}`);
  afirmar("archivo borrado", !fs.existsSync(path.join(dir, vc.file)), "no existe", "existe");
  afirmar("registro borrado", !(await version(A, pid, vc.id)), "sin registro", "sigue");
  const viva = await A.post(`/api/projects/${pid}/voz`, POST_VOZ("convertir"));
  const bor409 = await A.del(`/api/projects/${pid}/voz?version=${viva.json?.version?.id}`);
  afirmar("borrar una viva → 409", bor409.status === 409, 409, `${bor409.status} ${bor409.texto.slice(0, 100)}`);
  await A.post(`/api/projects/${pid}/voz`, { accion: "cancelar" });
  await espera(1000);

  // 11 — Aislamiento
  log("\n═══ 11. aislamiento entre usuarios ═══");
  await A.post("/api/voces/favoritas", { voiceId: "mock-radio", alias: "Radio de test" });
  const ajena = await O.get(`/api/projects/${pid}/voz`);
  afirmar("otro usuario → 404 en /voz", ajena.status === 404, 404, ajena.status);
  const favOtro = await O.get("/api/voces?lista=favoritas");
  afirmar("otro usuario no ve las favoritas del primero", favOtro.status === 200 && favOtro.json?.voces?.length === 0, "0 favoritas", JSON.stringify(favOtro.json?.voces?.map((v) => v.id)));
  await A.del("/api/voces/favoritas?voiceId=mock-radio");

  // 12 — Voces y favoritas
  log("\n═══ 12. voces y favoritas ═══");
  const pre = await A.get("/api/voces?lista=predeterminadas");
  afirmar("4 voces mock", pre.json?.voces?.length === 4, 4, pre.json?.voces?.length);
  await A.post("/api/voces/favoritas", { voiceId: "mock-grave", alias: "Grave test" });
  let favs = (await A.get("/api/voces?lista=favoritas")).json?.voces ?? [];
  afirmar("la favorita aparece con su alias", favs.some((v) => v.id === "mock-grave" && v.favorita?.alias === "Grave test"), "mock-grave / Grave test", JSON.stringify(favs.map((v) => [v.id, v.favorita?.alias])));
  const mala = await A.post("/api/voces/favoritas", { voiceId: "../x" });
  afirmar("voiceId invalido → 400", mala.status === 400, 400, mala.status);
  await A.del("/api/voces/favoritas?voiceId=mock-grave");
  favs = (await A.get("/api/voces?lista=favoritas")).json?.voces ?? [];
  afirmar("DELETE → desaparece", !favs.some((v) => v.id === "mock-grave"), "sin mock-grave", JSON.stringify(favs.map((v) => v.id)));

  // 13 — Borrar el proyecto a mitad (D18)
  log("\n═══ 13. borrar el proyecto a mitad de una conversion ═══");
  const mid = await A.post(`/api/projects/${pid}/voz`, POST_VOZ("convertir"));
  await hasta(async () => (await version(A, pid, mid.json?.version?.id))?.estado === "procesando", { ms: 20000, cada: 200, que: "procesando" });
  const delP = await A.del(`/api/projects/${pid}`);
  afirmar("DELETE proyecto → 200", delP.status === 200, 200, delP.status);
  await espera(3000);
  afirmar("3 s despues la carpeta NO existe", !fs.existsSync(dir), "no existe", `existe: ${fs.existsSync(dir) ? fs.readdirSync(dir).join(",") : ""}`);

  // 14 — Sin sesion
  log("\n═══ 14. sin sesion ═══");
  const s1 = await anon.get("/api/voces?lista=predeterminadas");
  const s2 = await anon.get(`/api/projects/${pid}/voz`);
  afirmar("sin cookie → 401 en /api/voces y en /voz", s1.status === 401 && s2.status === 401, "401 / 401", `${s1.status} / ${s2.status}`);

  fs.rmSync(TMP, { recursive: true, force: true });
  log("");
  if (fallos > 0) {
    log(`FALLOS: ${fallos}`);
    process.exit(1);
  }
  log("VOZ OK (mock)");
}

main().catch((e) => {
  console.error("\nno se pudo verificar:", e.message);
  process.exit(2);
});
