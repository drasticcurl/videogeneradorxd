#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# VERIFICACION DE ACEPTACION — aislamiento de proyectos por usuario.
#
#   bash tasks/aislamiento-por-usuario/_verificacion-aislamiento.sh
#
# Salida esperada cuando el modulo esta terminado: "AISLAMIENTO COMPLETO" y exit 0.
#
# ─── COMO LEER ESTE ARCHIVO ANTES DE EMPEZAR ─────────────────────────────────
#
# Tiene dos secciones y dan distinto segun el momento:
#
#   SECCION A — invariantes. Cosas que son verdad HOY y tienen que seguir siendo
#               verdad DESPUES. Si alguna se pone roja, se rompio algo que
#               funcionaba.
#   SECCION B — estado objetivo. El contrato (3 items) + las 21 rutas que tienen
#               que chequear al dueño. ANTES de implementar da 24 en pendiente,
#               Y ESO ESTA BIEN: es la lista de trabajo. Cada task la va poniendo
#               en verde de a pedazos.
#
# Corrido el 2026-09-08, antes de escribir una linea de codigo:
#
#   verde: 7   pendiente: 24   FALLO: 0
#
# Ese es el punto de partida exacto. Si al empezar te da otra cosa, alguien ya toco
# algo y hay que entender que antes de repartir las tasks.
#
# ─── POR QUE ESTE SCRIPT Y NO "compila" ──────────────────────────────────────
#
# Un chequeo de dueño que falta no rompe el build ni el typecheck: la ruta compila
# perfecto y sigue sirviendo lo ajeno. La unica forma de saber que estan TODAS es
# contarlas. Y son 21, en cuatro grupos con helper distinto, asi que "me parece que
# ya estan" no alcanza.
# ─────────────────────────────────────────────────────────────────────────────
set -u
cd "$(dirname "$0")/../.." || exit 1

ROJO=0
VERDE=0
PENDIENTES=0

ok()   { printf "  OK        %s\n" "$1"; VERDE=$((VERDE + 1)); }
mal()  { printf "  FALLO     %s\n" "$1"; printf "            %s\n" "$2"; ROJO=$((ROJO + 1)); }
falta(){ printf "  PENDIENTE %s\n" "$1"; PENDIENTES=$((PENDIENTES + 1)); }

# `grep -q` en un archivo que no existe da el mismo exit code que "no encontrado",
# y eso confundiria "todavia no lo hizo" con "borro el archivo". Se separan.
tiene() { # tiene <archivo> <patron>
  [ -f "$1" ] || return 2
  grep -q "$2" "$1"
}

echo "════════════════════════════════════════════════════════════════"
echo " SECCION A — invariantes (verdes antes y despues)"
echo "════════════════════════════════════════════════════════════════"
echo

# A1 — Los ids de job siguen derivandose del projectId.
#
# TODO el aislamiento de /api/jobs/:id/* depende de esto: `requireJobOwner` parsea
# el jobId para sacar el projectId. Si alguien cambia los ids a UUID aleatorios, el
# helper deja de poder resolver el dueño y hay que ir a buscar el job a la DB.
if tiene src/lib/jobs/pipeline.ts '`${projectId}:img:${imageId}`' \
  && tiene src/lib/jobs/pipeline.ts '`${projectId}:vid:${clipId}`'; then
  ok "A1 los ids de job siguen siendo <projectId>:img:<id> y <projectId>:vid:<id>"
else
  mal "A1 cambio el formato de los ids de job" \
      "requireJobOwner parsea el jobId para sacar el projectId. Ver pipeline.ts:43-48."
fi

# A2 — La sesion sigue resolviendose en el server con currentUser().
if tiene src/lib/auth.ts 'export function currentUser' \
  && tiene src/app/layout.tsx 'currentUser(cookies())'; then
  ok "A2 currentUser(cookies()) sigue siendo la fuente del usuario logueado"
else
  mal "A2 se movio o se renombro currentUser" \
      "ownership.ts lo envuelve en sessionUser(). Sin esto no hay de donde sacar el dueño."
fi

# A3 — Los 4 archivos que NADIE toca en este modulo siguen intactos en su superficie.
#
# `auth.ts` y `middleware.ts` no se tocan a proposito: el guard nuevo es de
# AUTORIZACION (quien es dueño de que) y el de ahi es de AUTENTICACION (quien sos).
# Mezclarlos hace que un bug de ownership pueda dejar la app abierta.
INTOCABLES_MODULO="src/lib/auth.ts src/middleware.ts src/lib/db.ts src/lib/batch.ts src/lib/jobs/queue.ts src/lib/jobs/pipeline.ts"
faltan_intocables=0
for f in $INTOCABLES_MODULO; do
  [ -f "$f" ] || { printf "            no existe %s\n" "$f"; faltan_intocables=1; }
done
if [ "$faltan_intocables" -eq 0 ]; then
  ok "A3 los 6 archivos intocables del modulo siguen presentes"
else
  mal "A3 falta un archivo intocable" "ver la lista de arriba"
fi

# A4 — El `owner` NUNCA se acepta del body de un request.
#
# Si una ruta lo lee del body, Ivan puede crear un proyecto a nombre de Lucho (o
# reasignarse uno ajeno con un PUT). El dueño sale SOLO de la cookie firmada.
if grep -rn --include='route.ts' -E '(body[?]?\.owner|body\["owner"\])' src/app/api/ >/dev/null 2>&1; then
  mal "A4 una ruta lee 'owner' del body" \
      "$(grep -rn --include='route.ts' -E '(body[?]?\.owner|body\["owner"\])' src/app/api/ | head -5)"
else
  ok "A4 ninguna ruta lee 'owner' del body del request"
fi

# A5 — Las 4 rutas que NO tienen dueño que chequear siguen sin el guard.
#
# Meterles el guard rompe cosas: /api/login es publica (si pide sesion no se puede
# entrar nunca) y /api/config, /api/parse y /api/prompt-template no reciben ningun
# projectId, asi que no hay nada que autorizar. Un guard ahi es ruido que despues
# alguien copia a donde si importa mal.
SIN_GUARD="src/app/api/login/route.ts src/app/api/config/route.ts src/app/api/parse/route.ts src/app/api/prompt-template/route.ts"
sobra_guard=0
for f in $SIN_GUARD; do
  if tiene "$f" 'ownership'; then
    printf "            %s importa ownership y no deberia\n" "$f"
    sobra_guard=1
  fi
done
if [ "$sobra_guard" -eq 0 ]; then
  ok "A5 login, config, parse y prompt-template siguen sin guard de dueño"
else
  mal "A5 una ruta sin dueño que chequear tiene el guard" "ver arriba"
fi

# A6 — La linea base de endpoints sigue en verde.
#
# Este modulo NO mueve ningun fetch: agrega chequeos del lado del server. Si la
# linea base se rompe, alguien toco una pantalla mas de lo necesario.
if [ -x tasks/_verificacion-endpoints.sh ] || [ -f tasks/_verificacion-endpoints.sh ]; then
  if bash tasks/_verificacion-endpoints.sh >/dev/null 2>&1; then
    ok "A6 tasks/_verificacion-endpoints.sh sigue en SIN REGRESIONES"
  else
    mal "A6 se rompio la linea base de endpoints" \
        "corré: bash tasks/_verificacion-endpoints.sh — no la 'arregles' tocando LINEA_BASE"
  fi
else
  mal "A6 no existe tasks/_verificacion-endpoints.sh" "es la linea base del rediseño anterior"
fi

# A7 — La migracion sigue en verde contra la base scratch.
if node tasks/aislamiento-por-usuario/_verificacion-migracion.mjs >/dev/null 2>&1; then
  ok "A7 _verificacion-migracion.mjs sigue en TODO EN VERDE (7/7)"
else
  mal "A7 la verificacion de la migracion dejo de pasar" \
      "corré: node tasks/aislamiento-por-usuario/_verificacion-migracion.mjs"
fi

echo
echo "════════════════════════════════════════════════════════════════"
echo " SECCION B — estado objetivo: las 21 rutas con chequeo de dueño"
echo "════════════════════════════════════════════════════════════════"
echo

# ─── B0. El contrato: ownership.ts con sus 5 exports ────────────────────────
echo "── el contrato (T01) ──"
if [ ! -f src/lib/ownership.ts ]; then
  falta "src/lib/ownership.ts todavia no existe (lo escribe T01)"
else
  faltan_exports=""
  for sym in sessionUser ownerOf requireProjectOwner requireJobOwner filterOwnedIds; do
    grep -q "export function $sym" src/lib/ownership.ts || faltan_exports="$faltan_exports $sym"
  done
  if [ -z "$faltan_exports" ]; then
    ok "src/lib/ownership.ts exporta los 5 del contrato"
  else
    mal "src/lib/ownership.ts no exporta:$faltan_exports" \
        "son el contrato congelado de §4 del plan. 5 tasks se escriben contra ellos."
  fi
fi

if tiene src/lib/types.ts 'owner'; then
  ok "ProjectRecord tiene el campo owner"
else
  falta "src/lib/types.ts todavia no tiene owner en ProjectRecord (lo agrega T01)"
fi

if [ -f scripts/migrar-owner.mjs ]; then
  ok "scripts/migrar-owner.mjs existe"
else
  falta "scripts/migrar-owner.mjs todavia no existe (T01 lo copia de la carpeta de tasks)"
fi

# ─── B1. Las 11 rutas de proyecto → requireProjectOwner ─────────────────────
echo
echo "── T02: rutas de /api/projects/[id] (11 archivos) ──"
RUTAS_PROYECTO="
src/app/api/projects/[id]/route.ts
src/app/api/projects/[id]/jobs/route.ts
src/app/api/projects/[id]/generate/route.ts
src/app/api/projects/[id]/control/route.ts
src/app/api/projects/[id]/stage/route.ts
src/app/api/projects/[id]/approve-batch/route.ts
src/app/api/projects/[id]/regenerate-batch/route.ts
src/app/api/projects/[id]/upload/route.ts
src/app/api/projects/[id]/references/route.ts
src/app/api/projects/[id]/stitch/route.ts
src/app/api/projects/[id]/download/route.ts
"
for f in $RUTAS_PROYECTO; do
  tiene "$f" 'requireProjectOwner'
  case $? in
    0) ok "${f#src/app/api/}" ;;
    1) falta "${f#src/app/api/} sin requireProjectOwner" ;;
    2) mal "${f#src/app/api/} NO EXISTE" "se borro una ruta que la UI usa" ;;
  esac
done

# ─── B2. Las 6 rutas de job → requireJobOwner ───────────────────────────────
echo
echo "── T03: rutas de /api/jobs/[id] (6 archivos) ──"
RUTAS_JOB="
src/app/api/jobs/[id]/approve/route.ts
src/app/api/jobs/[id]/unapprove/route.ts
src/app/api/jobs/[id]/retry/route.ts
src/app/api/jobs/[id]/prompt/route.ts
src/app/api/jobs/[id]/extend/route.ts
src/app/api/jobs/[id]/preview/route.ts
"
for f in $RUTAS_JOB; do
  tiene "$f" 'requireJobOwner'
  case $? in
    0) ok "${f#src/app/api/}" ;;
    1) falta "${f#src/app/api/} sin requireJobOwner" ;;
    2) mal "${f#src/app/api/} NO EXISTE" "se borro una ruta que la UI usa" ;;
  esac
done

# ─── B3. Creacion y listado → sessionUser ───────────────────────────────────
echo
echo "── T04: creacion y listado (2 archivos) ──"
# `GET /api/projects` tiene que FILTRAR y `POST` tiene que SETEAR el owner. Los dos
# necesitan el usuario de la sesion, asi que se pide sessionUser en el archivo.
for f in src/app/api/projects/route.ts src/app/api/imagenes/route.ts; do
  tiene "$f" 'sessionUser'
  case $? in
    0) ok "${f#src/app/api/}" ;;
    1) falta "${f#src/app/api/} sin sessionUser" ;;
    2) mal "${f#src/app/api/} NO EXISTE" "se borro una ruta que la UI usa" ;;
  esac
done

# ─── B4. Los dos caminos donde el id viene de afuera ────────────────────────
echo
echo "── T05: archivos y lote (2 archivos) ──"
# /api/files sirve TODO lo generado y hoy ni consulta la DB: es el agujero por el
# que se ven imagenes y videos ajenos con solo saber un projectId.
tiene 'src/app/api/files/[...path]/route.ts' 'requireProjectOwner'
case $? in
  0) ok "files/[...path]/route.ts" ;;
  1) falta "files/[...path]/route.ts sin requireProjectOwner" ;;
  2) mal "files/[...path]/route.ts NO EXISTE" "es el que sirve todas las imagenes y videos" ;;
esac

# /api/batch recibe los ids por la URL, asi que filtra en vez de rechazar.
tiene src/app/api/batch/route.ts 'filterOwnedIds'
case $? in
  0) ok "batch/route.ts" ;;
  1) falta "batch/route.ts sin filterOwnedIds" ;;
  2) mal "batch/route.ts NO EXISTE" "es el tablero de lotes" ;;
esac

# ─── Cierre ─────────────────────────────────────────────────────────────────
echo
echo "════════════════════════════════════════════════════════════════"
printf " verde: %s   pendiente: %s   FALLO: %s\n" "$VERDE" "$PENDIENTES" "$ROJO"
echo "════════════════════════════════════════════════════════════════"

if [ "$ROJO" -gt 0 ]; then
  echo
  echo "HAY FALLOS. Un FALLO no es 'todavia no lo hice': es algo que estaba bien y"
  echo "se rompio, o un archivo que desaparecio. Arreglalo antes de seguir."
  exit 1
fi

if [ "$PENDIENTES" -gt 0 ]; then
  echo
  echo "PENDIENTES: $PENDIENTES. Es la lista de trabajo que queda."
  echo "Al empezar el modulo, lo normal es 24 pendientes (3 del contrato + 21 rutas)"
  echo "y 0 fallos. Cuando llegue a 0, el modulo esta terminado."
  exit 1
fi

echo
echo "AISLAMIENTO COMPLETO"
exit 0
