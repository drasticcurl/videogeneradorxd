#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
# deploy.sh — build + activacion de una release nueva del generador.
#
#   sudo -u deploy bash /srv/generador/repo/deploy/deploy.sh
#
# Layout que asume:
#   /srv/generador/repo                     ← clon de git (main)
#   /srv/generador/shared/.env.production   ← secretos (chmod 600)
#   /srv/generador/shared/adc.json          ← credenciales de Vertex (chmod 600)
#   /srv/generador/storage/{data,output}    ← ESTADO PERSISTENTE, fuera de las releases
#   /srv/generador/releases/<timestamp>/    ← releases
#   /srv/generador/current                  ← symlink → <release>/.next/standalone
#
# ─── LO MAS IMPORTANTE DE ESTE ARCHIVO ────────────────────────────────────────
#
# `storage/` esta AFUERA del arbol de releases y eso no es un detalle de gusto.
# `src/lib/config.ts` resuelve DATA_DIR y OUTPUT_DIR con `resolveFromCwd()`: si
# son relativos, se resuelven contra el cwd del proceso, que es
# /srv/generador/current, o sea ADENTRO de la release. Cada deploy crea una
# release nueva y la poda borra las viejas: los proyectos, las imagenes y los
# videos generados desaparecerian en el deploy siguiente sin ningun error.
# El paso 3 aborta el deploy si esos paths no son absolutos.
#
# Garantias:
#   - Un solo deploy a la vez (flock).
#   - Si el build falla, `current` no se toca y la release a medio hacer se borra.
#   - Si no contesta despues del reload, vuelve solo a la release anterior.
# ══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ┌───────────────────────────────────────────────────────────────────────────┐
# │ ESTE SCRIPT SE CORRE COMO EL USUARIO `deploy`, NUNCA COMO root.           │
# └───────────────────────────────────────────────────────────────────────────┘
# `pm2` es POR USUARIO: root tiene su propio daemon. Corrido como root, el
# `pm2 start` de mas abajo crea un generador-3006 en el pm2 de root en vez de
# recargar el que esta sirviendo (el de `deploy`), y el nuevo entra en ciclo de
# reinicios porque el puerto ya esta tomado. El health check pasa igual, porque
# contesta el viejo, asi que el deploy dice OK sin haber desplegado nada.
# Ademas .env.production quedaria root:root e ilegible para deploy.
if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  echo "ERROR: no corras deploy.sh como root." >&2
  echo "       usa: sudo -u deploy bash /srv/generador/repo/deploy/deploy.sh" >&2
  exit 1
fi

BASE=/srv/generador
SHARED="$BASE/shared"
REPO="$BASE/repo"
RELEASES="$BASE/releases"
ECOSYSTEM="$REPO/deploy/ecosystem.config.js"
APP=generador-3006
PORT=3006
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"

STAMP="$(date +%Y%m%d%H%M%S)"
RELEASE="$RELEASES/$STAMP"
LOGFILE="$BASE/deploy.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOGFILE"; }

ACTIVATED=0
fail() {
  log "FALLO: $*"
  # Solo se borra la release si NO se activo. Si ya se activo y algo fallo
  # despues, el rollback la necesita para poder mirarla.
  if [[ "$ACTIVATED" -eq 0 && -d "$RELEASE" ]]; then
    rm -rf "$RELEASE"
    log "release $STAMP borrada (no se habia activado)"
  fi
  exit 1
}

# ─── Un build a la vez ──────────────────────────────────────────────────────
# Dos deploys simultaneos se pisan el `git reset` del repo compartido y pueden
# dejar una release construida con el codigo del otro.
exec 9>"$BASE/.deploy.lock"
flock -n 9 || { echo "ya hay un deploy corriendo"; exit 1; }

log "═══ deploy $STAMP ═══"

# ─── 0. Traer el codigo ─────────────────────────────────────────────────────
cd "$REPO"
git fetch --quiet origin "$DEPLOY_BRANCH" || fail "git fetch falló"

# Este script VIVE en el repo que esta por actualizar, asi que el `git reset` de
# abajo puede reescribir el archivo que bash esta ejecutando. Bash lee el script
# por offset de bytes, asi que si el archivo cambia de tamaño sigue leyendo desde
# la posicion vieja del archivo nuevo: ejecuta lineas cortadas, o vuelve a
# ejecutar un pedazo. Paso en el primer deploy: el fix de `npm ci --include=dev`
# estaba en el disco y aun asi corrio la version anterior, y el log lo mostro
# porque imprimio el mensaje viejo.
#
# La solucion es re-ejecutarse una sola vez con la version nueva. El guard
# DEPLOY_REEXEC evita un loop infinito si algo sale raro con el hash.
ANTES="$(sha256sum "$REPO/deploy/deploy.sh" | cut -d' ' -f1)"

# `reset --hard` y no `pull`: el repo del server no tiene que tener cambios
# locales nunca, y un merge a medio hacer bloquearia todos los deploys.
git reset --quiet --hard "origin/$DEPLOY_BRANCH" || fail "git reset falló"
COMMIT="$(git rev-parse --short HEAD)"
log "codigo en $DEPLOY_BRANCH @ $COMMIT — $(git log -1 --pretty=%s)"

DESPUES="$(sha256sum "$REPO/deploy/deploy.sh" | cut -d' ' -f1)"
if [[ "$ANTES" != "$DESPUES" && -z "${DEPLOY_REEXEC:-}" ]]; then
  log "deploy.sh cambio en este commit — re-ejecutando con la version nueva"
  # El lock se libera al reemplazar el proceso (exec cierra el fd 9 al terminar
  # este), y el proceso nuevo lo vuelve a tomar. No hay ventana util para otro
  # deploy porque el exec es inmediato.
  flock -u 9
  exec env DEPLOY_REEXEC=1 bash "$REPO/deploy/deploy.sh" "$@"
fi

# ─── 1. repo → release ──────────────────────────────────────────────────────
mkdir -p "$RELEASE"
# --exclude .git: la release no necesita el historial, son ~3 MB por release.
# --exclude node_modules: se instala limpio con npm ci mas abajo.
rsync -a --exclude '.git' --exclude 'node_modules' --exclude '.next' \
  "$REPO/" "$RELEASE/" || fail "rsync repo → release falló"
log "release copiada en $RELEASE"

# ─── 2. Secretos ────────────────────────────────────────────────────────────
# Tiene que estar ANTES del build: `NEXT_PUBLIC_SITE_URL` se hornea en el bundle
# del cliente y `AUTH_SECRET` en el bundle del middleware. Un build sin este
# archivo compila bien y despues no deja entrar a nadie.
[[ -f "$SHARED/.env.production" ]] || fail "falta $SHARED/.env.production"
install -m 600 "$SHARED/.env.production" "$RELEASE/.env.production"

# ─── 3. Guards de configuracion ─────────────────────────────────────────────
# Todos abortan ANTES del build: es mas rapido y no deja una release a medias.
set -a
# shellcheck disable=SC1091
. "$RELEASE/.env.production"
set +a

# 3a. Auth. Sin esto la app compila y arranca, pero no entra NADIE: el login
# falla cerrado a proposito. Mejor que el deploy se detenga y se vea.
[[ -n "${AUTH_SECRET:-}" ]] || fail "falta AUTH_SECRET en .env.production — nadie podria entrar"
if ! grep -qE '^PASSWORD_[A-Z0-9_]+=.+' "$RELEASE/.env.production"; then
  fail "no hay ninguna PASSWORD_<NOMBRE> en .env.production — nadie podria entrar"
fi
USUARIOS="$(grep -oE '^PASSWORD_[A-Z0-9_]+=' "$RELEASE/.env.production" | sed 's/^PASSWORD_//;s/=$//' | tr '\n' ' ')"
log "usuarios habilitados: $USUARIOS"

# 3b. El redirect al login. Sin esta var, detras del proxy Next arma req.url con
# la direccion donde escucha el proceso y el redirect sale a 127.0.0.1:3006.
[[ -n "${NEXT_PUBLIC_SITE_URL:-}" ]] || fail "falta NEXT_PUBLIC_SITE_URL — el redirect al login saldria a 127.0.0.1"

# 3c. LO QUE MAS IMPORTA: los paths de estado tienen que ser ABSOLUTOS y estar
# afuera del arbol de releases. Ver el comentario del encabezado.
for var in DATA_DIR OUTPUT_DIR; do
  val="${!var:-}"
  [[ -n "$val" ]] || fail "falta $var en .env.production"
  [[ "$val" = /* ]] || fail "$var='$val' es relativo: se resolveria adentro de la release y el proximo deploy borraria todo lo generado"
  case "$val" in
    "$RELEASES"/*|"$BASE"/current/*|"$BASE"/current)
      fail "$var='$val' apunta adentro del arbol de releases: el proximo deploy lo borraria" ;;
  esac
  mkdir -p "$val" || fail "no se pudo crear $var='$val'"
  [[ -w "$val" ]] || fail "$var='$val' no es escribible por $(id -un)"
done
log "estado persistente: DATA_DIR=$DATA_DIR OUTPUT_DIR=$OUTPUT_DIR"

# 3d. Credenciales de Vertex. En modo vertex, sin esto cada job falla en runtime
# con un error de ADC y la UI muestra los jobs en rojo sin explicar por que.
#
# Se chequea POR USUARIO, con el mismo orden que `vertexCuentaFor` (src/lib/cuentaVertex.ts):
#   1. la cuenta que cargo desde la app (DATA_DIR/cuentas-vertex/cuentas.json): ya se probo
#      contra Google al cargarla, asi que aca no se mira nada mas;
#   2. GOOGLE_CLOUD_PROJECT_<NOMBRE> (+ opcional GOOGLE_APPLICATION_CREDENTIALS_<NOMBRE>);
#   3. la compartida (GOOGLE_CLOUD_PROJECT + GOOGLE_APPLICATION_CREDENTIALS).
#
# Lo que esta MAL configurado corta (un JSON ilegible, un JSON propio sin proyecto). Un
# usuario SIN NINGUNA cuenta solo avisa: con la carga desde la app, el usuario nuevo entra
# primero y carga la suya despues, y cortar el deploy por eso no lo dejaria entrar nunca.
if [[ "${PROVIDER_MODE:-mock}" == "vertex" ]]; then
  chequear_json() { # $1 = nombre de la var, $2 = path
    [[ -r "$2" ]] || fail "no se puede leer $1='$2' como $(id -un)"
    python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$2" \
      || fail "$1='$2' no es JSON valido"
  }
  if [[ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]]; then
    chequear_json GOOGLE_APPLICATION_CREDENTIALS "$GOOGLE_APPLICATION_CREDENTIALS"
  fi
  # Usuarios con cuenta cargada desde la app, en minusculas. Vacio si no hay ninguno o si
  # el indice no se puede leer (ahi cada uno cae a las reglas del .env, que es lo mismo
  # que haria la app).
  CARGADAS=" $(python3 -c 'import json,sys; print(" ".join(json.load(open(sys.argv[1]))["porUsuario"]))' \
    "$DATA_DIR/cuentas-vertex/cuentas.json" 2>/dev/null || true) "
  for u in $USUARIOS; do
    u_min="$(printf '%s' "$u" | tr '[:upper:]' '[:lower:]')"
    if [[ "$CARGADAS" == *" $u_min "* ]]; then
      log "vertex: $u → cuenta cargada desde la app"
      continue
    fi
    var_proy="GOOGLE_CLOUD_PROJECT_$u"
    var_cred="GOOGLE_APPLICATION_CREDENTIALS_$u"
    proy="${!var_proy:-}"
    cred="${!var_cred:-}"
    if [[ -n "$cred" ]]; then
      # Sin proyecto propio la app NO cae al compartido (le facturaria a otro): corta.
      [[ -n "$proy" ]] || fail "$var_cred esta pero falta $var_proy"
      chequear_json "$var_cred" "$cred"
      log "vertex: $u → cuenta propia, proyecto $proy, credenciales en $cred"
    elif [[ -z "$proy" && -z "${GOOGLE_CLOUD_PROJECT:-}" ]]; then
      log "AVISO: $u no tiene cuenta de Vertex y no hay compartida: no va a poder generar hasta cargar la suya desde la app (su nombre, arriba a la derecha)"
    else
      [[ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]] \
        || fail "PROVIDER_MODE=vertex: $u usa las credenciales compartidas pero falta GOOGLE_APPLICATION_CREDENTIALS (o dale $var_cred)"
      if [[ -n "$proy" ]]; then
        log "vertex: $u → proyecto propio $proy, credenciales compartidas"
      else
        log "vertex: $u → cuenta compartida, proyecto $GOOGLE_CLOUD_PROJECT"
      fi
    fi
  done
fi

# 3e. Binarios del sistema que la app usa por spawn.
#
# No son dependencias de npm, asi que nada las instala solo y su ausencia no se nota
# hasta que alguien aprieta el boton que las usa. Paso de verdad: `zip` no viene en
# Ubuntu Server (si vienen tar y gzip) y la descarga de videos fallaba en runtime con
# "El comando 'zip' no esta disponible", ya con los clips generados y pagados.
#
# ffmpeg/ffprobe son fail porque sin ellos no hay export; zip es warning porque solo
# rompe la descarga en .zip y el resto de la app anda igual.
for bin in ffmpeg ffprobe; do
  command -v "$bin" >/dev/null 2>&1 || fail "falta el binario '$bin' (apt-get install -y ffmpeg)"
done
if command -v zip >/dev/null 2>&1; then
  log "binarios ok: ffmpeg, ffprobe, zip"
else
  log "AVISO: falta 'zip' — la descarga de videos va a fallar. Instalalo: apt-get install -y zip"
fi

# 3f. Cambio de voz. VOICE_PROVIDER=elevenlabs sin key compila y arranca, pero cada conversion
# falla en runtime con "no esta configurado". Mejor que el deploy se detenga y se vea.
# El grep solo mira que haya ALGUNA key con valor: la key no se imprime nunca, ni en el
# log ni en el fail (el log del deploy queda en disco y el repo es publico).
if [[ "${VOICE_PROVIDER:-mock}" == "elevenlabs" ]]; then
  grep -qE '^ELEVENLABS_API_KEY(_[A-Z0-9_]+)?=.+' "$RELEASE/.env.production" \
    || fail "VOICE_PROVIDER=elevenlabs pero no hay ninguna ELEVENLABS_API_KEY en .env.production"
  log "voz: elevenlabs"
fi

# ─── 4. Build ───────────────────────────────────────────────────────────────
cd "$RELEASE"
# `--include=dev` es OBLIGATORIO y no redundante. El paso 3 hace `source` del
# .env.production para los guards, y ese archivo setea NODE_ENV=production; con
# NODE_ENV=production, `npm ci` SALTEA las devDependencies, que es donde viven
# typescript, tailwind y postcss. Sin el flag, el typecheck muere con
# "sh: 1: tsc: not found" y, si se saltara el typecheck, el build fallaria al no
# encontrar tailwind. Paso en el primer deploy.
npm ci --include=dev --no-audit --no-fund >>"$LOGFILE" 2>&1 || fail "npm ci falló (ver $LOGFILE)"
# Guard explicito: si algun dia cambia el comportamiento de npm, el error tiene
# que decir QUE falta, no "tsc: not found" tres lineas mas abajo.
[[ -x "$RELEASE/node_modules/.bin/tsc" ]] || fail "no se instalaron las devDependencies (falta tsc) — ¿NODE_ENV=production sin --include=dev?"
log "dependencias instaladas (con devDependencies)"

npm run typecheck >>"$LOGFILE" 2>&1 || fail "typecheck falló (ver $LOGFILE)"
log "typecheck ok"

npm run build >>"$LOGFILE" 2>&1 || fail "build falló (ver $LOGFILE)"
log "build ok"

# ─── 5. Completar el standalone ─────────────────────────────────────────────
# Next NO copia public/ ni .next/static/ adentro de .next/standalone/. Sin estos
# dos cp la app sale sin CSS, y la pantalla de login queda sin estilos.
STANDALONE="$RELEASE/.next/standalone"
[[ -f "$STANDALONE/server.js" ]] || fail "no se generó .next/standalone (¿falta output:'standalone' en next.config.js?)"
mkdir -p "$STANDALONE/.next/static"
cp -a "$RELEASE/.next/static/." "$STANDALONE/.next/static/"
if [[ -d "$RELEASE/public" ]]; then
  mkdir -p "$STANDALONE/public"
  cp -a "$RELEASE/public/." "$STANDALONE/public/"
fi
# El .env.production tambien adentro del standalone: `current` apunta ahi, es el
# cwd del proceso, y Next lee .env.production del cwd en runtime.
install -m 600 "$SHARED/.env.production" "$STANDALONE/.env.production"
# `prompts/` lo lee promptTemplate.server.ts en runtime desde el cwd.
if [[ -d "$RELEASE/prompts" ]]; then
  cp -a "$RELEASE/prompts" "$STANDALONE/prompts"
fi
log "standalone completo (.next/static + .env.production + prompts)"

# ─── 6. Activar ─────────────────────────────────────────────────────────────
# `readlink -e` y no -f: -f imprime el path y sale 0 aunque el ultimo componente
# no exista, asi que en el primer deploy PREVIOUS quedaria igual a
# "$BASE/current" y un rollback armaria un symlink apuntandose a si mismo.
PREVIOUS="$(readlink -e "$BASE/current" 2>/dev/null || true)"

# El swap tiene que ser atomico: `ln -sfn` sobre un symlink existente hace
# unlink + symlink, y en esa ventana `current` no existe. `mv -T` es un solo
# rename(2): no hay ventana.
ln -sfn "$STANDALONE" "$BASE/current.tmp"
mv -Tf "$BASE/current.tmp" "$BASE/current"
ACTIVATED=1
log "current → $STANDALONE"

# PM2 SIEMPRE con el environment limpio, nunca con el de este script.
#
# El paso 3 hace `set -a; . .env.production`, asi que este shell tiene TODAS las vars
# de la app exportadas. Un `pm2 reload --update-env` desde aca se las copia al
# environment que PM2 guarda del proceso, y PM2 las FUSIONA con las que ya tenia:
# una var que se borra del .env.production queda viva en el proceso para siempre, y
# como process.env le gana al .env que lee Next, la app la sigue usando. Paso de
# verdad (2026-09-26): se comento GOOGLE_CLOUD_PROJECT para dejar a un usuario sin la
# cuenta compartida, y el proceso la siguio usando. Con PASSWORD_<NOMBRE> es peor:
# borrarla para echar a alguien no lo echaba. Y `pm2 save` escribia los secretos en
# ~/.pm2/dump.pm2.
#
# Las vars de la app las lee Next del .env.production del standalone (paso 5); PM2 no
# tiene que llevar ninguna. `env -i` le pasa solo lo que necesita para encontrar su
# daemon. Si algun dia hubiera que limpiar un proceso que ya quedo sucio: `pm2 delete`
# + `pm2 start` del ecosystem con este mismo `env -i`, y `pm2 save`.
pm2_limpio() {
  env -i HOME="$HOME" PATH="$PATH" ${PM2_HOME:+PM2_HOME="$PM2_HOME"} pm2 "$@"
}

rollback_to_previous() {
  if [[ -n "$PREVIOUS" && -f "$PREVIOUS/server.js" ]]; then
    ln -sfn "$PREVIOUS" "$BASE/current.tmp"
    mv -Tf "$BASE/current.tmp" "$BASE/current"
    pm2_limpio reload "$APP" --update-env || true
    log "revertido a $PREVIOUS"
  else
    log "sin release anterior valida para revertir (¿primer deploy?)"
  fi
}

# ─── 7. Reload + health check ───────────────────────────────────────────────
# OJO: un reload REINICIA el proceso, y como la cola de jobs es in-memory, los
# jobs en vuelo se pierden (los archivos ya escritos quedan; el progreso no).
# No deployes con una generacion corriendo.
if pm2 describe "$APP" >/dev/null 2>&1; then
  pm2_limpio reload "$APP" --update-env || { rollback_to_previous; fail "pm2 reload falló"; }
else
  log "$APP no existe en PM2 — primer arranque"
  pm2_limpio start "$ECOSYSTEM" || { rollback_to_previous; fail "pm2 start falló"; }
fi

# Se chequea /login y no /: `/` redirige al login con 307 cuando no hay cookie,
# pero /login tiene que devolver 200 con HTML de verdad. Es la unica ruta que
# prueba que el server renderiza Y que el middleware la deja pasar.
ok=0
code=""
for _ in $(seq 1 20); do
  sleep 2
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/login" || true)"
  [[ "$code" == "200" ]] && { ok=1; break; }
done
if ((!ok)); then
  log "no contesto 200 en /login (ultimo codigo: ${code:-sin respuesta})"
  rollback_to_previous
  fail "deploy revertido"
fi
log "health check ok (/login → 200)"

# El guard de mas arriba mira el .env; esto mira lo que el proceso VE de verdad.
# Un .env correcto con un proceso que quedo con el environment viejo (vars viejas
# guardadas en PM2, ver `pm2_limpio`, o un pm2 de otro usuario) da exactamente el
# mismo sintoma que no tener el archivo: se generan videos que nadie encuentra despues.
VISTO="$(curl -s "http://127.0.0.1:$PORT/api/config" || true)"
case "$VISTO" in
  *"$OUTPUT_DIR"*) log "el proceso ve OUTPUT_DIR=$OUTPUT_DIR" ;;
  *'"error":"No autenticado'*|*'No autenticado'*)
    # /api/config esta detras del login, asi que un 401 aca es la respuesta
    # correcta: confirma que el guard esta puesto.
    log "api/config responde 401 (el guard de auth esta activo)" ;;
  *) log "AVISO: no se pudo confirmar OUTPUT_DIR contra /api/config" ;;
esac

# ─── 8. Poda ────────────────────────────────────────────────────────────────
# Es seguro porque el estado persistente vive en storage/, afuera de las
# releases. Si alguien pone DATA_DIR/OUTPUT_DIR adentro de una release, el guard
# del paso 3c ya aborto el deploy antes de llegar aca.
cd "$RELEASES"
CURRENT_REAL="$(readlink -e "$BASE/current" || true)"
# shellcheck disable=SC2012  # se ordena por fecha, y `ls -t` es lo que hace eso.
ls -1dt -- */ 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | while read -r old; do
  old="${old%/}"
  # Nunca la que esta sirviendo, por mas vieja que sea.
  case "$CURRENT_REAL" in "$RELEASES/$old"/*) continue ;; esac
  # Los `:?` no son decorativos: si las dos variables quedaran vacias por un bug,
  # esta linea seria `rm -rf /`. Con `:?` bash aborta en vez de borrar el server.
  # Y el nombre tiene que ser un timestamp: cualquier otra cosa no la borramos.
  case "$old" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;;
    *) log "salteada '$old': no tiene forma de release, no se toca"; continue ;;
  esac
  rm -rf "${RELEASES:?}/${old:?}"
  log "podada release $old"
done

log "═══ deploy $STAMP OK — $APP @ $COMMIT ═══"
