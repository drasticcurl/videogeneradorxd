#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# VERIFICACION DE ACEPTACION — cambio de voz (ElevenLabs).
#
#   bash tasks/cambio-de-voz/_verificacion-voz.sh
#   bash tasks/cambio-de-voz/_verificacion-voz.sh | grep '\[T03\]'    # solo lo de una task
#
# Salida esperada cuando el modulo esta terminado: "CAMBIO DE VOZ COMPLETO" y exit 0.
#
# ─── COMO LEER ESTE ARCHIVO ANTES DE EMPEZAR ─────────────────────────────────
#
#   SECCION A — invariantes. Verdad HOY y tiene que seguir siendolo DESPUES. Si una
#               se pone roja, se rompio algo que funcionaba (o se filtro la key).
#   SECCION B — estado objetivo, con la task duena entre corchetes. ANTES de
#               implementar da todo PENDIENTE, y esta bien: es la lista de trabajo.
#               Un PENDIENTE que pasa a FALLO es peor que uno que sigue pendiente:
#               significa que el archivo existe pero hace otra cosa que el contrato.
#
# Corrido el 2026-09-25, antes de escribir una linea de codigo del modulo:
#
#   verde: 10   pendiente: 40   FALLO: 0
#
# Si al empezar te da otra cosa, alguien ya toco algo: entendelo antes de repartir.
#
# El script en si tambien se probo, en una copia descartable del repo:
#   - con archivos minimos que cumplen el contrato (y una implementacion de
#     referencia de tramos.ts): verde 50, pendiente 0, FALLO 0;
#   - en negativo, cada uno da FALLO y no PENDIENTE: tramos cortados a mitad de clip
#     (B17), un import de runtime en tramos.ts (B14), la key escrita en una ruta y
#     nombrada en un componente de cliente (A2), y el DELETE del proyecto borrando la
#     carpeta antes de cancelar la conversion (B27).
#
# ─── POR QUE ESTE SCRIPT Y NO "compila" ──────────────────────────────────────
#
# Casi todo lo que puede salir mal en este modulo compila perfecto: una key que
# llega a un componente de cliente, una ruta nueva sin chequeo de dueño, un corte
# de tramo corrido un clip, un DELETE que borra la carpeta ANTES de cancelar la
# conversion (y la conversion la recrea). Los chequeos B15-B19 llaman a la funcion
# pura de verdad con node (type stripping de Node >= 22.18): no alcanza con que
# exista, tiene que dar los numeros de §8 del diseño.
# ─────────────────────────────────────────────────────────────────────────────
set -u
cd "$(dirname "$0")/../.." || exit 1

VERDE=0
ROJO=0
PENDIENTES=0

ok()   { printf "  OK        %s\n" "$1"; VERDE=$((VERDE + 1)); }
mal()  { printf "  FALLO     %s\n" "$1"; printf "            %s\n" "$2"; ROJO=$((ROJO + 1)); }
falta(){ printf "  PENDIENTE %s\n" "$1"; PENDIENTES=$((PENDIENTES + 1)); }

# `grep -q` sobre un archivo que no existe da el mismo exit code que "no encontrado".
# Se separan para no confundir "todavia no lo hizo" con "borro el archivo".
tiene() { # tiene <archivo> <regex-extendida>
  [ -f "$1" ] || return 2
  grep -qE -- "$2" "$1"
}

# Objetivo simple: todos los patrones en el mismo archivo.
objetivo() { # objetivo <descripcion> <archivo> <regex> [<regex>...]
  local desc="$1" f="$2"; shift 2
  local p
  for p in "$@"; do
    if ! tiene "$f" "$p"; then falta "$desc"; return; fi
  done
  ok "$desc"
}

DISENO="tasks/cambio-de-voz/02-DISENO.md"

echo "════════════════════════════════════════════════════════════════"
echo " SECCION A — invariantes (verdes antes y despues)"
echo "════════════════════════════════════════════════════════════════"
echo

# A1 — El stitch sigue chequeando dueño. T04 edita esa ruta: si se pierde el guard,
# cualquiera re-une (y pisa) el video de un proyecto ajeno.
if tiene 'src/app/api/projects/[id]/stitch/route.ts' 'requireProjectOwner'; then
  ok "A1  el stitch sigue chequeando dueño"
else
  mal "A1  el stitch sigue chequeando dueño" "falta requireProjectOwner en projects/[id]/stitch/route.ts"
fi

# A2 — La key no sale de su jaula (D13, §13):
#   a) el header xi-api-key solo lo escribe src/lib/voz/elevenlabs.ts
#   b) el VALOR de la key solo se lee de process.env en src/lib/config.ts
#   c) ningun archivo de cliente ("use client") menciona ELEVENLABS
# Mencionar el NOMBRE de la variable en un mensaje de error del server esta bien.
a2=""
x=$(grep -rlE 'xi-api-key' src 2>/dev/null | grep -vE '^src/lib/voz/elevenlabs\.ts$')
[ -n "$x" ] && a2="$a2 header-en:[$x]"
x=$(grep -rlE 'process\.env(\.|\[)[^;]*ELEVENLABS_API_KEY' src 2>/dev/null | grep -vE '^src/lib/config\.ts$')
[ -n "$x" ] && a2="$a2 lee-la-key:[$x]"
x=$(grep -rlE '^"use client"' src 2>/dev/null | xargs grep -lE 'ELEVENLABS' 2>/dev/null)
[ -n "$x" ] && a2="$a2 cliente:[$x]"
if [ -z "$a2" ]; then
  ok "A2  la API key de ElevenLabs no sale del server"
else
  mal "A2  la API key de ElevenLabs no sale del server" "encontrada fuera de lugar:$a2"
fi

# A3 — Los .env con la key nunca entran a git (el repo es PUBLICO).
if tiene .gitignore '^\.env\*\.local$' && tiene .gitignore '^\.env\.production\*$'; then
  ok "A3  .gitignore cubre .env*.local y .env.production*"
else
  mal "A3  .gitignore cubre .env*.local y .env.production*" "revisá .gitignore: la key terminaria en un repo publico"
fi

# A4 — "Unir en un video" sigue existiendo para el proyecto SIN unido. El modulo
# agrega "Volver a unir"; no reemplaza el boton de siempre.
if tiene 'src/app/project/[id]/result/page.tsx' 'Unir en un video'; then
  ok "A4  Resultado sigue ofreciendo \"Unir en un video\""
else
  mal "A4  Resultado sigue ofreciendo \"Unir en un video\"" "se perdio el boton de SinVideoFinal"
fi

# A5 — runFfmpeg lo usa el extend de video (pipeline.ts) y stitchProject la ruta de
# stitch. T01 y T04 editan ffmpeg.ts: ninguno puede sacarlos.
if tiene src/lib/ffmpeg.ts '^export function runFfmpeg\(' && tiene src/lib/ffmpeg.ts '^export function stitchProject\('; then
  ok "A5  ffmpeg.ts sigue exportando runFfmpeg y stitchProject"
else
  mal "A5  ffmpeg.ts sigue exportando runFfmpeg y stitchProject" "pipeline.ts (extend) o la ruta de stitch quedan rotos"
fi

# A6 — db.json no cambia de forma (D14: las favoritas van en su propio archivo).
campos=$(sed -n '/^interface DbShape/,/^}/p' src/lib/db.ts | grep -cE '^[[:space:]]+[a-z]+:')
if [ "$campos" = "3" ] && ! grep -qiE 'favorit|voz' src/lib/db.ts; then
  ok "A6  db.ts sigue con projects/jobs/logs y sin nada de voz"
else
  mal "A6  db.ts sigue con projects/jobs/logs y sin nada de voz" "DbShape tiene $campos campos o db.ts menciona voz/favoritas (ver D14)"
fi

# A7 — El cliente no importa modulos de server del modulo (traen node:fs / la key).
x=$(grep -rlE '^"use client"' src 2>/dev/null | xargs grep -lE 'from "@/lib/(voz|unido)' 2>/dev/null)
if [ -z "$x" ]; then
  ok "A7  ningun componente de cliente importa @/lib/voz ni @/lib/unido"
else
  mal "A7  ningun componente de cliente importa @/lib/voz ni @/lib/unido" "importan: $x (los tipos van en @/lib/types)"
fi

# A8 — La linea base de endpoints sigue verde. T06 AGREGA una linea (el dialogo);
# si otra cambia, alguien se llevo un fetch que no tenia que tocar.
if bash tasks/_verificacion-endpoints.sh 2>/dev/null | tail -1 | grep -q 'SIN REGRESIONES'; then
  ok "A8  _verificacion-endpoints.sh: SIN REGRESIONES"
else
  mal "A8  _verificacion-endpoints.sh: SIN REGRESIONES" "correlo a mano para ver que pantalla cambio"
fi

# A9 — Toda ruta tiene al menos un boton. Las 3 rutas nuevas tienen que estar
# llamadas desde la UI, o este chequeo las marca SIN USO.
if bash tasks/_verificacion-acciones-alcanzables.sh 2>/dev/null | tail -1 | grep -q 'TODAS LAS ACCIONES SON ALCANZABLES'; then
  ok "A9  _verificacion-acciones-alcanzables.sh: todas alcanzables"
else
  mal "A9  _verificacion-acciones-alcanzables.sh: todas alcanzables" "correlo a mano: alguna ruta quedo SIN USO"
fi

# A10 — Toda ruta bajo projects/[id]/ chequea dueño. Cubre sola a la ruta nueva de voz.
sin_guard=""
while IFS= read -r f; do
  grep -q 'requireProjectOwner' "$f" || sin_guard="$sin_guard $f"
done < <(find 'src/app/api/projects/[id]' -name route.ts | sort)
if [ -z "$sin_guard" ]; then
  ok "A10 toda ruta de projects/[id]/ usa requireProjectOwner"
else
  mal "A10 toda ruta de projects/[id]/ usa requireProjectOwner" "sin guard:$sin_guard"
fi

echo
echo "════════════════════════════════════════════════════════════════"
echo " SECCION B — estado objetivo (pendiente antes de implementar)"
echo "════════════════════════════════════════════════════════════════"
echo

# ── T00 — spike ──────────────────────────────────────────────────────────────
objetivo "B1  [T00] resultados del spike anotados" \
  tasks/cambio-de-voz/_spike-resultados.md 'Δ duración' 'créditos'

# ── T01 — fundacion ──────────────────────────────────────────────────────────
b2=1
for t in AjustesDeVoz ClipEnReceta RecetaUnido EstadoUnido VersionDeVoz VozResumen VozFavorita \
         VozEnLista CreditosDeVoz EstimacionDeVoz RespuestaEstadoVoz RespuestaVoces; do
  tiene src/lib/types.ts "^export interface $t\b" || b2=0
done
tiene src/lib/types.ts '^export type EstadoVersionDeVoz\b' || b2=0
[ "$b2" = 1 ] && ok "B2  [T01] types.ts exporta los 13 tipos de §4" || falta "B2  [T01] types.ts exporta los 13 tipos de §4"

objetivo "B3  [T01] ProjectRecord: recetaUnido? y versionesVoz? (OPCIONALES)" \
  src/lib/types.ts 'recetaUnido\?: RecetaUnido;' 'versionesVoz\?: VersionDeVoz\[\];'
objetivo "B4  [T01] config.ts: bloque voz + elevenLabsKeyFor()" \
  src/lib/config.ts '^export function elevenLabsKeyFor\(' '^[[:space:]]+voz: \{' 'VOICE_PROVIDER'
objetivo "B5  [T01] .env.example documenta las variables de voz" \
  .env.example '^VOICE_PROVIDER=' '^ELEVENLABS_API_KEY=' '^ELEVENLABS_STS_MODEL=' '^ELEVENLABS_OUTPUT_FORMAT=' '^VOICE_CHUNK_MAX_SEC='
objetivo "B6  [T01] voz/tipos.ts: VOICE_ID_RE, VozProvider, ErrorDeVoz" \
  src/lib/voz/tipos.ts '^export const VOICE_ID_RE' '^export interface VozProvider' '^export class ErrorDeVoz'
objetivo "B7  [T01] voz/estado.ts: BOOT_ID, esCorridaViva, corridaVivaDe" \
  src/lib/voz/estado.ts '^export const BOOT_ID' '^export function esCorridaViva\(' '^export function corridaVivaDe\('
objetivo "B8  [T01] unido.ts: estadoDelUnido, recetaVigente" \
  src/lib/unido.ts '^export function estadoDelUnido\(' '^export function recetaVigente\('
objetivo "B9  [T01] ffmpeg.ts: runFfmpegAsync" \
  src/lib/ffmpeg.ts '^export function runFfmpegAsync\('

# ── T02 — proveedores y favoritas ────────────────────────────────────────────
objetivo "B10 [T02] voz/elevenlabs.ts: STS + voces + VOICE_ID_RE + xi-api-key" \
  src/lib/voz/elevenlabs.ts 'xi-api-key' '/v1/speech-to-speech/' '/v2/voices' 'VOICE_ID_RE'
objetivo "B11 [T02] voz/mock.ts: voces fijas + ffmpeg async + demora de prueba" \
  src/lib/voz/mock.ts 'mock-grave' 'runFfmpegAsync' 'VOICE_MOCK_DELAY_MS'
objetivo "B12 [T02] voz/index.ts: getVozProvider, vozDisponible" \
  src/lib/voz/index.ts '^export function getVozProvider\(' '^export function vozDisponible\('
objetivo "B13 [T02] voz/favoritas.ts: favoritasDe/guardarFavorita/quitarFavorita en su archivo" \
  src/lib/voz/favoritas.ts '^export function favoritasDe\(' '^export function guardarFavorita\(' \
  '^export function quitarFavorita\(' 'voces-favoritas\.json'

# ── T03 — motor ──────────────────────────────────────────────────────────────
T="src/lib/voz/tramos.ts"
if [ ! -f "$T" ]; then
  falta "B14 [T03] voz/tramos.ts: 4 exports y SOLO import type"
else
  runtime_imports=$(grep -nE '^import ' "$T" | grep -vE '^[0-9]+:import type ')
  exports_ok=1
  for fn in debeConvertirse armarPiezas ventanaDePrueba estimar; do
    grep -qE "^export function $fn\(" "$T" || exports_ok=0
  done
  if [ -n "$runtime_imports" ]; then
    mal "B14 [T03] voz/tramos.ts: 4 exports y SOLO import type" "tiene imports de runtime (tiene que ser PURO, §8): $runtime_imports"
  elif [ "$exports_ok" = 0 ]; then
    mal "B14 [T03] voz/tramos.ts: 4 exports y SOLO import type" "falta alguno de: debeConvertirse armarPiezas ventanaDePrueba estimar"
  else
    ok "B14 [T03] voz/tramos.ts: 4 exports y SOLO import type"
  fi
fi

# B15-B19: los ejemplos de §8, ejecutando la funcion real.
if [ -f "$T" ]; then
  salida=$(node --no-warnings -e '
    import("./src/lib/voz/tramos.ts").then((m) => {
      const c = (id, i, f, etiqueta, conDialogo) => ({ id, assetId: "a", etiqueta, conDialogo,
        file: `clips/${id}.mp4`, mtimeMs: 0, bytes: 0, inicioSeg: i, finSeg: f });
      const receta = { file: "x.mp4", creadoEn: "t", duracionSeg: 30.06, clips: [
        c("c1", 0, 8, "IA", true), c("c2", 8, 16.06, "IA", true),
        c("c3", 16.06, 22.06, "FILMAR_REAL", true), c("c4", 22.06, 30.06, "IA", false) ] };
      const n = (x) => String(+Number(x).toFixed(2));
      const s = (ps) => ps.map((p) => `${p.tipo === "convertir" ? "C" : "K"} ${n(p.inicioSeg)}-${p.finSeg === null ? "fin" : n(p.finSeg)} [${p.clipIds.join(",")}]`).join(" · ");
      console.log("1=" + s(m.armarPiezas(receta, { incluirFilmados: false, maxSeg: 270 })));
      console.log("2=" + s(m.armarPiezas(receta, { incluirFilmados: true, maxSeg: 270 })));
      console.log("3=" + s(m.armarPiezas(receta, { incluirFilmados: false, maxSeg: 10 })));
      const v = m.ventanaDePrueba(receta, { incluirFilmados: false, pruebaSeg: 20 });
      console.log("4=" + (v ? `${n(v.inicioSeg)}-${n(v.finSeg)} → ` + s(m.armarPiezas(receta, { incluirFilmados: false, maxSeg: 270, ventana: v })) : "null"));
      const p1 = m.armarPiezas(receta, { incluirFilmados: false, maxSeg: 270 });
      const e = (fac) => { const r = m.estimar(p1, { facturacion: fac, precioPorMinUsd: 0.12, duracionTotalSeg: 30.06 });
        return `${n(r.segundos)}|${r.tramos}|${r.creditos}|${n(r.usd)}`; };
      console.log("5=" + e("por_minuto") + " ; " + e("proporcional"));
    }).catch((err) => { console.log("ERROR=" + err.message); });
  ' 2>&1)
fi
chequear_caso() { # chequear_caso <id> <descripcion> <esperado>
  if [ ! -f "$T" ]; then falta "$2"; return; fi
  local real
  real=$(printf '%s\n' "$salida" | sed -n "s/^$1=//p")
  if [ "$real" = "$3" ]; then
    ok "$2"
  else
    local err
    err=$(printf '%s\n' "$salida" | sed -n 's/^ERROR=//p')
    mal "$2" "esperado: $3 | real: ${real:-${err:-(nada)}}"
  fi
}
chequear_caso 1 "B15 [T03] armarPiezas: filmados afuera"      "C 0-16.06 [c1,c2] · K 16.06-fin [c3,c4]"
chequear_caso 2 "B16 [T03] armarPiezas: filmados adentro"     "C 0-22.06 [c1,c2,c3] · K 22.06-fin [c4]"
chequear_caso 3 "B17 [T03] armarPiezas: tramo maximo de 10 s" "C 0-8 [c1] · C 8-16.06 [c2] · K 16.06-fin [c3,c4]"
chequear_caso 4 "B18 [T03] ventana de prueba de 20 s"         "0-20 → C 0-16.06 [c1,c2] · K 16.06-20 [c3]"
chequear_caso 5 "B19 [T03] estimar: por minuto ; proporcional" "16.06|1|1000|0.12 ; 16.06|1|268|0.03"

# "-c:v" y "copy" por separado: este repo escribe un argumento de ffmpeg por linea
# (ver stitchProject), asi que exigirlos juntos en una linea daria PENDIENTE sobre
# una implementacion correcta.
objetivo "B20 [T03] voz/audio.ts: ffmpeg async, cortes por muestra, video copiado" \
  src/lib/voz/audio.ts 'runFfmpegAsync' 'atrim=start_sample' 'apad=whole_len' '"-c:v"' '"copy"'
C="src/lib/voz/corrida.ts"
if [ ! -f "$C" ]; then
  falta "B21 [T03] voz/corrida.ts: contrato de §10.1 y nada de spawnSync"
elif grep -q 'spawnSync' "$C"; then
  mal "B21 [T03] voz/corrida.ts: contrato de §10.1 y nada de spawnSync" "usa spawnSync: congela la app entera (D10)"
else
  objetivo "B21 [T03] voz/corrida.ts: contrato de §10.1 y nada de spawnSync" \
    "$C" '^export function iniciarCorrida\(' '^export function cancelarCorrida\(' \
    '^export function reconciliarTrasReinicio\(' '^export class ErrorDeCorrida'
fi

# ── T04 — el unido con receta ────────────────────────────────────────────────
objetivo "B22 [T04] stitchProject devuelve la receta" \
  src/lib/ffmpeg.ts 'receta\?: RecetaUnido'
objetivo "B23 [T04] stitch: persiste la receta y contesta 409 con conversion viva" \
  'src/app/api/projects/[id]/stitch/route.ts' 'recetaUnido' 'corridaVivaDe' 'status: 409'

# ── T05 — rutas ──────────────────────────────────────────────────────────────
objetivo "B24 [T05] GET /api/voces con sesion" \
  src/app/api/voces/route.ts '^export async function GET\(' 'sessionUser'
objetivo "B25 [T05] POST/DELETE /api/voces/favoritas con sesion" \
  src/app/api/voces/favoritas/route.ts '^export async function POST\(' '^export async function DELETE\(' 'sessionUser'
objetivo "B26 [T05] /api/projects/:id/voz: GET/POST/DELETE, dueño, 202, reconciliacion" \
  'src/app/api/projects/[id]/voz/route.ts' '^export async function GET\(' '^export async function POST\(' \
  '^export async function DELETE\(' 'requireProjectOwner' 'status: 202' 'reconciliarTrasReinicio'
P='src/app/api/projects/[id]/route.ts'
lc=$(grep -n 'cancelarCorrida(' "$P" 2>/dev/null | head -1 | cut -d: -f1)
lr=$(grep -n 'removeProjectDir(' "$P" 2>/dev/null | head -1 | cut -d: -f1)
if [ -z "$lc" ]; then
  falta "B27 [T05] DELETE del proyecto cancela la conversion ANTES de borrar la carpeta"
elif [ -n "$lr" ] && [ "$lc" -lt "$lr" ]; then
  ok "B27 [T05] DELETE del proyecto cancela la conversion ANTES de borrar la carpeta"
else
  mal "B27 [T05] DELETE del proyecto cancela la conversion ANTES de borrar la carpeta" \
    "cancelarCorrida (linea $lc) tiene que ir antes que removeProjectDir (linea ${lr:-?}): D18"
fi
objetivo "B28 [T05] el zip incluye las versiones de voz" \
  'src/app/api/projects/[id]/download/route.ts' 'versionesVoz'

# ── T06 — UI ─────────────────────────────────────────────────────────────────
objetivo "B29 [T06] CambiarVozDialog: cliente, lista de voces y favoritas" \
  src/components/CambiarVozDialog.tsx '^"use client"' '/api/voces\?' '/api/voces/favoritas'
objetivo "B30 [T06] Resultado: Cambiar voz, Volver a unir y el estado de /voz" \
  'src/app/project/[id]/result/page.tsx' 'Cambiar voz' 'Volver a unir' '/voz`'
objetivo "B31 [T06] ui-tokens: estadoDeVersionDeVoz" \
  src/lib/ui-tokens.ts '^export function estadoDeVersionDeVoz\('
objetivo "B32 [T06] la linea base de endpoints protege el dialogo nuevo" \
  tasks/_verificacion-endpoints.sh '^src/components/CambiarVozDialog\.tsx\|'

# ── T07 — verificacion, docs y deploy ───────────────────────────────────────
objetivo "B33 [T07] la verificacion E2E en mock existe" \
  tasks/cambio-de-voz/_verificacion-voz-mock.mjs 'VOZ OK'
objetivo "B34 [T07] la verificacion de UI mira los botones de Resultado" \
  tasks/_verificacion-ui-funcional.mjs 'Cambiar voz' 'Volver a unir'
objetivo "B35 [T07] deploy.sh: guard de VOICE_PROVIDER=elevenlabs sin key" \
  deploy/deploy.sh 'VOICE_PROVIDER' 'ELEVENLABS_API_KEY'
objetivo "B36 [T07] README: seccion y rutas del cambio de voz" \
  README.md '^## Cambio de voz' '/api/projects/:id/voz'
objetivo "B37 [T07] CHANGELOG: la tanda anotada" \
  CHANGELOG.md '[Cc]ambio de voz'
objetivo "B38 [T07] BITACORA: la entrada del modulo" \
  docs/BITACORA-IMPLEMENTACION.md '[Cc]ambio de voz'
objetivo "B39 [T07] steering: el modulo nuevo, para las proximas sesiones" \
  .kiro/steering/project-context.md 'src/lib/voz'

# ── T08 — produccion ─────────────────────────────────────────────────────────
res=$(grep -cE '^- \*\*Resolución \(' "$DISENO" 2>/dev/null)
if [ "${res:-0}" -ge 3 ]; then
  ok "B40 [T08] P-01, P-02 y P-03 resueltas en §17 con datos reales"
else
  falta "B40 [T08] P-01, P-02 y P-03 resueltas en §17 con datos reales"
fi

echo
echo "────────────────────────────────────────────────────────────────"
printf " verde: %s   pendiente: %s   FALLO: %s\n" "$VERDE" "$PENDIENTES" "$ROJO"
echo "────────────────────────────────────────────────────────────────"

if [ "$ROJO" -gt 0 ]; then
  echo "HAY FALLOS: se rompio un invariante o algo existe y no cumple el contrato."
  exit 1
fi
if [ "$PENDIENTES" -gt 0 ]; then
  echo "EN CURSO: faltan $PENDIENTES."
  exit 0
fi
echo "CAMBIO DE VOZ COMPLETO"
