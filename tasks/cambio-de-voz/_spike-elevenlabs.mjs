#!/usr/bin/env node
// T00 — spike: medir ElevenLabs (Voice Changer) con audio real de Veo antes de escribir el motor.
//
//   ELEVENLABS_API_KEY=... node tasks/cambio-de-voz/_spike-elevenlabs.mjs <video.mp4> [--voz <id>]
//
// La key se lee SOLO del environment y no se imprime nunca, ni enmascarada: el repo es publico y
// cualquier salida de este script puede terminar pegada en un issue o en la bitacora.
// Sin dependencias: fetch/FormData/Blob nativos y ffmpeg con spawnSync (es un script, no la app:
// aca bloquear el event loop no le hace dano a nadie).
// Los audios quedan en /tmp/spike-voz/, fuera del repo.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = process.env.ELEVENLABS_API_KEY || "";
const BASE = (process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io").replace(/\/+$/, "");
const MODELO = process.env.ELEVENLABS_STS_MODEL || "eleven_multilingual_sts_v2";
const OUT = "/tmp/spike-voz";
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RESULTADOS = path.join(AQUI, "_spike-resultados.md");

const args = process.argv.slice(2);
const video = args.find((a) => !a.startsWith("--"));
const iVoz = args.indexOf("--voz");
let vozId = iVoz >= 0 ? args[iVoz + 1] : null;

if (!KEY) { console.error("Falta ELEVENLABS_API_KEY en el environment."); process.exit(2); }
if (!video || !fs.existsSync(video)) { console.error("Uso: node _spike-elevenlabs.mjs <video.mp4> [--voz <id>]"); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- utilidades
function ff(bin, a) {
  const r = spawnSync(bin, a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${bin} fallo: ${(r.stderr || "").slice(-400)}`);
  return r;
}
function dur(file) {
  // Duracion decodificando a PCM: la de formato de un mp3 puede estar estimada por bitrate.
  const tmp = path.join(OUT, `_dec_${path.basename(file)}.wav`);
  ff("ffmpeg", ["-y", "-v", "error", "-i", file, "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", tmp]);
  const r = ff("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=duration_ts,sample_rate", "-of", "json", tmp]);
  const s = JSON.parse(r.stdout).streams[0];
  return { seg: Number(s.duration_ts) / Number(s.sample_rate), wav: tmp };
}
function silencios(file) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", file, "-af", "silencedetect=n=-35dB:d=0.15", "-f", "null", "-"], { encoding: "utf8" });
  const st = [...(r.stderr || "").matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const en = [...(r.stderr || "").matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  return { starts: st, ends: en };
}
// Corrimiento: primera silence_end (ataque de voz) de salida menos la de entrada. Si el audio arranca
// hablando (Veo lo hace seguido) no hay silence_end inicial: se usa la primera silence_start.
function corrimientoMs(inWav, outWav) {
  const a = silencios(inWav), b = silencios(outWav);
  if (a.ends.length && b.ends.length && a.ends[0] < 3) return { ms: Math.round((b.ends[0] - a.ends[0]) * 1000), ref: "silence_end" };
  if (a.starts.length && b.starts.length) return { ms: Math.round((b.starts[0] - a.starts[0]) * 1000), ref: "silence_start" };
  return { ms: null, ref: "sin pausas" };
}
async function api(pathname, init = {}) {
  const res = await fetch(BASE + pathname, { ...init, headers: { ...(init.headers || {}), "xi-api-key": KEY } });
  return res;
}
async function cuerpo(res) {
  const t = await res.text();
  try { return JSON.parse(t); } catch { return t.slice(0, 500); }
}
async function suscripcion() {
  const r = await api("/v1/user/subscription");
  if (!r.ok) return { ok: false, status: r.status, body: await cuerpo(r) };
  const j = await r.json();
  return { ok: true, tier: j.tier, usados: j.character_count, limite: j.character_limit };
}
async function sts({ wav, voz, formato = "mp3_44100_128", quitarRuido = true, etiqueta }) {
  const fd = new FormData();
  fd.append("audio", new Blob([fs.readFileSync(wav)], { type: "audio/wav" }), "tramo.wav");
  fd.append("model_id", MODELO);
  fd.append("remove_background_noise", quitarRuido ? "true" : "false");
  const t0 = Date.now();
  const res = await api(`/v1/speech-to-speech/${encodeURIComponent(voz)}?output_format=${formato}`, { method: "POST", body: fd });
  const latenciaMs = Date.now() - t0;
  if (!res.ok) return { ok: false, status: res.status, body: await cuerpo(res), latenciaMs };
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = formato.startsWith("wav") ? "wav" : "mp3";
  const file = path.join(OUT, `${etiqueta}.${ext}`);
  fs.writeFileSync(file, buf);
  return { ok: true, file, latenciaMs, bytes: buf.length };
}
function recortar(desde, seg, nombre) {
  // Mismo formato que manda la app (diseno §9 paso 2): WAV PCM s16le mono 44,1 kHz.
  // -stream_loop -1 repite el audio si el video es mas corto que el largo pedido.
  const out = path.join(OUT, nombre);
  ff("ffmpeg", ["-y", "-v", "error", "-stream_loop", "-1", "-i", video, "-ss", String(desde), "-t", String(seg), "-vn", "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", out]);
  return out;
}
const log = [];
function anotar(s) { console.log(s); log.push(s); }
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- pasos
const filas = [];
const videoDur = Number(ff("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video]).stdout.trim());

// 1 — modelos
const rm = await api("/v1/models");
let modelosSts = [];
if (rm.ok) {
  modelosSts = (await rm.json()).filter((m) => m.can_do_voice_conversion).map((m) => m.model_id);
  anotar(`1. Modelos con can_do_voice_conversion: ${modelosSts.join(", ") || "(ninguno)"}`);
} else {
  anotar(`1. GET /v1/models -> ${rm.status}: ${JSON.stringify(await cuerpo(rm))}`);
}

// 2 — suscripcion antes
const s0 = await suscripcion();
anotar(s0.ok ? `2. Plan: ${s0.tier} · créditos usados ${s0.usados} de ${s0.limite}` : `2. /v1/user/subscription -> ${s0.status} (la key no tiene user_read)`);

// voz de prueba
if (!vozId) {
  const rv = await api("/v2/voices?voice_type=default&page_size=10&sort=name&sort_direction=asc");
  if (!rv.ok) { anotar(`GET /v2/voices -> ${rv.status}: ${JSON.stringify(await cuerpo(rv))}`); process.exit(1); }
  const v = (await rv.json()).voices?.[0];
  vozId = v?.voice_id;
  anotar(`   Voz de prueba: ${v?.name} (${vozId})`);
}

// 3 — fragmento de 20 s
const in20 = recortar(0, 20, "entrada_20s.wav");
anotar(`3. Fragmento de 20 s extraído de ${path.basename(video)} (${videoDur.toFixed(1)} s)`);

async function medir(etiqueta, inWav, opts) {
  const r = await sts({ wav: inWav, voz: vozId, etiqueta, ...opts });
  if (!r.ok) { anotar(`   ${etiqueta}: ${r.status} ${JSON.stringify(r.body)}`); return { etiqueta, ...r }; }
  const di = dur(inWav).seg;
  const d = dur(r.file);
  const c = corrimientoMs(inWav, d.wav);
  const fila = { etiqueta, entradaSeg: di, salidaSeg: d.seg, deltaMs: Math.round((d.seg - di) * 1000), deltaPct: ((d.seg - di) / di) * 100, corrimiento: c, latenciaMs: r.latenciaMs, file: r.file, ok: true };
  anotar(`   ${etiqueta}: entrada ${di.toFixed(3)} s · salida ${d.seg.toFixed(3)} s · Δ ${fila.deltaMs} ms (${fila.deltaPct.toFixed(2)} %) · corrimiento ${c.ms ?? "?"} ms (${c.ref}) · latencia ${(r.latenciaMs / 1000).toFixed(1)} s`);
  return fila;
}

// 4 — STS 20 s mp3 con quitar ruido
anotar("4. STS 20 s, mp3_44100_128, remove_background_noise=true");
const f20 = await medir("salida_20s_con-quitar-ruido", in20, { quitarRuido: true });

// 5 — creditos del pedido de 20 s. La suscripcion puede tardar en reflejar el consumo: se espera.
await espera(5000);
const s1 = await suscripcion();
let creditos20 = null;
if (s0.ok && s1.ok) { creditos20 = s1.usados - s0.usados; anotar(`5. Créditos del pedido de 20 s: ${creditos20}`); }
else anotar("5. No se pudo leer la suscripción: créditos sin medir");
f20.creditos = creditos20;
filas.push(f20);

// 6 — sin quitar ruido
anotar("6. STS 20 s, remove_background_noise=false");
const f20b = await medir("salida_20s_sin-quitar-ruido", in20, { quitarRuido: false });
filas.push(f20b);

// 7 — wav_44100
anotar("7. STS 20 s, output_format=wav_44100");
const rw = await sts({ wav: in20, voz: vozId, formato: "wav_44100", etiqueta: "salida_20s_wav" });
const wavRes = rw.ok ? "200: el plan acepta wav_44100" : `${rw.status}: ${JSON.stringify(rw.body)}`;
anotar(`   ${wavRes}`);

// 8 — 60 s y 270 s
const sPre = await suscripcion();
anotar("8. STS 60 s y 270 s (mp3)");
const in60 = recortar(0, 60, "entrada_60s.wav");
const f60 = await medir("salida_60s", in60, { quitarRuido: true });
filas.push(f60);
const in270 = recortar(0, 270, "entrada_270s.wav");
anotar(`   entrada de 270 s: ${(fs.statSync(in270).size / 1e6).toFixed(1)} MB`);
const f270 = await medir("salida_270s", in270, { quitarRuido: true });
filas.push(f270);
await espera(5000);
const sPost = await suscripcion();
const creditos60y270 = sPre.ok && sPost.ok ? sPost.usados - sPre.usados : null;
if (creditos60y270 != null) anotar(`   Créditos de 60 s + 270 s juntos: ${creditos60y270}`);

// 9 — voz inexistente
anotar("9. STS con voice_id inexistente");
const rx = await sts({ wav: in20, voz: "noexiste123", etiqueta: "noexiste" });
const noexiste = rx.ok ? "200 (inesperado)" : `${rx.status} ${JSON.stringify(rx.body)}`;
anotar(`   ${noexiste}`);

// ---------------------------------------------------------------- resultados
const fmt = (f) => f.ok
  ? `| ${f.etiqueta} | ${f.entradaSeg.toFixed(3)} s | ${f.salidaSeg.toFixed(3)} s | ${f.deltaMs} ms (${f.deltaPct.toFixed(2)} %) | ${f.corrimiento.ms ?? "?"} ms (${f.corrimiento.ref}) | ${(f.latenciaMs / 1000).toFixed(1)} s | ${f.creditos ?? "—"} |`
  : `| ${f.etiqueta} | — | — | falló: ${f.status} | — | — | — |`;
const maxPct = Math.max(...filas.filter((f) => f.ok).map((f) => Math.abs(f.deltaPct)));
const maxMs = Math.max(...filas.filter((f) => f.ok).map((f) => Math.abs(f.deltaMs)));
const corr = filas.filter((f) => f.ok && f.corrimiento.ms != null).map((f) => f.corrimiento.ms);
const corrMed = corr.length ? Math.round(corr.reduce((a, b) => a + b, 0) / corr.length) : null;
const corrFijo = corr.length >= 2 && Math.max(...corr) - Math.min(...corr) <= 15 && corrMed > 15;

const billing = creditos20 == null ? "sin medir (queda `por_minuto`)" : creditos20 >= 900 ? "`por_minuto` (el pedido de 20 s costó ~1.000)" : "`proporcional`";
const md = `# T00 — Resultados del spike de ElevenLabs

- **Fecha:** ${new Date().toISOString()}
- **Plan (tier):** ${s0.ok ? s0.tier : "sin permiso de user_read"}
- **Modelo usado:** ${MODELO}
- **Video:** \`${path.basename(video)}\` (${videoDur.toFixed(1)} s, Veo). Los tramos de 60 y 270 s repiten su audio
  (\`-stream_loop\`): sirven para límite, deriva y latencia, no para calidad.
- **Voz:** \`${vozId}\`

## Mediciones

| Pedido | Entrada | Salida | Δ duración | Corrimiento | Latencia | Créditos |
|---|---|---|---|---|---|---|
${filas.map(fmt).join("\n")}

- Créditos de 60 s + 270 s juntos: ${creditos60y270 ?? "sin medir"}
- Modelos con \`can_do_voice_conversion\`: ${modelosSts.join(", ") || "sin medir"}
- \`output_format=wav_44100\`: ${wavRes}
- \`voice_id\` inexistente: ${noexiste}

## Log

\`\`\`
${log.join("\n")}
\`\`\`

## Decisiones (tabla de §16 del diseño)

- **Δ duración máxima:** ${maxMs} ms (${maxPct.toFixed(2)} %). ${maxPct > 5 ? "**PASA EL 5 %: PARAR, §8-§9 no sirven.**" : maxMs <= 50 ? "≤ 50 ms: D5 tal cual." : "Entre 50 ms y 5 %: D5 tal cual (el atempo lo corrige)."}
- **VOICE_OFFSET_MS:** ${corrFijo ? `${corrMed} (corrimiento fijo medido)` : `0 (corrimiento no fijo o ≤ 15 ms: ${corr.join(", ") || "sin medir"} ms)`}
- **VOICE_BILLING:** ${billing}
- **ELEVENLABS_OUTPUT_FORMAT:** ${rw.ok ? "el plan acepta `wav_44100`; opcional usarlo" : "`mp3_44100_128` (wav no disponible en el plan)"}
- **ELEVENLABS_TIMEOUT_MS:** ${f270.ok ? (f270.latenciaMs < 150000 ? "180000 alcanza" : `subirlo: el tramo de 270 s tardó ${(f270.latenciaMs / 1000).toFixed(0)} s`) : "sin medir (el tramo de 270 s falló)"}
- **Modelo:** ${modelosSts.includes(MODELO) ? `\`${MODELO}\` sigue disponible` : `\`${MODELO}\` NO aparece`}${modelosSts.filter((m) => m !== MODELO).length ? `; también: ${modelosSts.filter((m) => m !== MODELO).join(", ")} (P-02: no se cambia sin escuchar)` : ""}

Audios para escuchar (fuera del repo): \`${OUT}/salida_20s_con-quitar-ruido.mp3\` y \`${OUT}/salida_20s_sin-quitar-ruido.mp3\`.
`;
fs.writeFileSync(RESULTADOS, md);
console.log(`\nResultados en ${RESULTADOS}`);
