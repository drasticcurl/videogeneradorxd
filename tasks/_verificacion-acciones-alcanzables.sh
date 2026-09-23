#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Verificacion 4 — "todo endpoint tiene al menos un boton".
#
#   bash tasks/_verificacion-acciones-alcanzables.sh
#
# Salida esperada: "TODAS LAS ACCIONES SON ALCANZABLES" y exit 0.
#
# ─── POR QUE EXISTE, Y QUE SE LE ESCAPO A LOS OTROS TRES ─────────────────────
#
# El 2026-09-23 se descubrio que el rediseño habia dejado DOS acciones sin ningun
# boton que las llamara:
#
#   POST /api/jobs/:id/approve   (para clips de video)
#   POST /api/jobs/:id/extend    (el "+7s", inalcanzable desde TODA la app)
#
# Las dos desaparecieron cuando el pipeline reemplazo las `JobCard` de video por
# lista + editor: `JobCard` traia los botones, el editor nuevo no. El endpoint
# siguio vivo, el `extendJob` siguio en el store, y el README siguio documentando la
# funcion. Nadie se dio cuenta hasta que un usuario pregunto "me desaparecio el
# boton de aprobar clip".
#
# Ninguna de las tres verificaciones podia cazarlo:
#   - `_verificacion-endpoints.sh` compara PREFIJOS (`/api/jobs/`), y el pipeline
#     seguia mencionando ese prefijo por el preview del job. Sin regresiones.
#   - typecheck: `extendJob` estaba importado del store y asignado a un callback.
#     Codigo muerto perfectamente tipado.
#   - el build: ni se entera.
#
# Esto mira al revés que las otras: parte de los route handlers que EXISTEN y exige
# que cada uno se mencione en algun archivo de interfaz.
#
# ─── QUE CAZA Y QUE NO. LEER ANTES DE CONFIAR ────────────────────────────────
#
# CAZA: que se borre el ultimo llamador de un endpoint. Si alguien saca una pantalla
# entera, o reemplaza un componente por otro y se olvida de portar el fetch, aca sale
# SIN USO.
#
# NO CAZA el caso que motivó este archivo, y conviene ser honesto: el `extend` estaba
# MENCIONADO todo el tiempo. La cadena existía completa —`extendJob` en el store,
# importado por el pipeline, envuelto en un `useCallback`, metido en un objeto
# `handlers`— y lo que la cortaba era la CONDICIÓN DE RENDER del final:
# `handlers` llegaba sólo a las tarjetas de imagen, y `JobCard` muestra ese botón con
# `!isImage && onExtend`. O sea: para imágenes nunca, y a los videos ya no les
# llegaba. Sintaxis impecable, botón inalcanzable. Se probó simulando la pérdida y
# este script siguió diciendo OK.
#
# Para eso está `_verificacion-ui-funcional.mjs`, que abre la app de verdad y busca
# los botones en el DOM renderizado. Ese es el que hay que correr cuando se toca una
# pantalla; este es el piso baratísimo que corre en un segundo.
# ─────────────────────────────────────────────────────────────────────────────
set -u
cd "$(dirname "$0")/.." || exit 1

# Donde vive la interfaz. `store/` cuenta: es la capa que llama a la API por las
# pantallas, y un endpoint alcanzable desde una accion del store esta alcanzable.
UI_GLOBS=(src/app src/components src/store)

# Endpoints que a proposito NO se llaman desde la interfaz.
# Si se agrega uno, va con el motivo al lado o no va.
declare -a EXCEPCIONES=(
  # El navegador la pide solo al renderizar <img>/<video> y en los href de descarga:
  # nunca hay un `fetch("/api/files/...")`. Esta cubierta por
  # `_verificacion-endpoints.sh`, que si cuenta `/api/files/` por archivo.
  "/api/files"

  # REDUNDANTE, y viene de antes del rediseño: quedo sin llamadores en 6069ed6
  # ("feat(batch): tablero de lotes, staging y descarga"). La UI cambia la fase por
  # `POST /api/batch` con `start-images`/`start-videos`, que setea `stage` adentro
  # (ver src/app/api/batch/route.ts). Este handler queda como acceso directo por
  # curl para mover la fase de UN proyecto sin armar un lote. No se borra porque
  # borrar un endpoint documentado en el README es un cambio de API, no limpieza.
  "/api/projects/stage"
)

# Matchea por prefijo o por ruta sin los segmentos dinamicos, asi la excepcion se
# escribe legible (`/api/files`) y no con la forma del filesystem
# (`/api/files/[...path]`).
es_excepcion() {
  local ruta="$1"
  # /api/projects/[id]/stage -> /api/projects/stage
  local sin_dinamicos
  sin_dinamicos=$(printf '%s\n' "$ruta" | sed -E 's|/\[[^]]*\]||g')
  for e in "${EXCEPCIONES[@]}"; do
    [ "$ruta" = "$e" ] && return 0
    [ "$sin_dinamicos" = "$e" ] && return 0
    case "$ruta" in "$e"/*) return 0 ;; esac
  done
  return 1
}

fallos=0
total=0

echo "═══ cada endpoint tiene al menos un consumidor en la interfaz ═══"
echo

# Un route handler por cada `route.ts` bajo src/app/api.
while IFS= read -r archivo; do
  # src/app/api/jobs/[id]/extend/route.ts  ->  /api/jobs/[id]/extend
  ruta="/${archivo#src/app/}"
  ruta="${ruta%/route.ts}"

  es_excepcion "$ruta" && continue
  total=$((total + 1))

  # El ultimo segmento es lo que identifica la ACCION. Si es dinamico (`[id]`,
  # `[...path]`) no hay literal para buscar: la accion es el recurso de arriba.
  ultimo="${ruta##*/}"
  if [[ "$ultimo" == \[* ]]; then
    sin_ultimo="${ruta%/*}"
    aguja="${sin_ultimo##*/}"
  else
    aguja="$ultimo"
  fi

  # Se busca `/<aguja>` seguido de un cierre plausible de string/template, para no
  # contar una mencion en prosa de un comentario. Cubre las cuatro formas que usa
  # este repo:  `/api/x`   `${id}/x`   "/api/x?y=1"   `/api/x?v=${v}`
  if grep -rqE "/${aguja}(\`|\"|'|\?|\\\$)" "${UI_GLOBS[@]}" --include=*.ts --include=*.tsx 2>/dev/null; then
    # Sin acento en el nombre: bash no acepta identificadores no-ASCII y lo trata
    # como un comando ("dónde=...: No such file or directory").
    ubicacion=$(grep -rlE "/${aguja}(\`|\"|'|\?|\\\$)" "${UI_GLOBS[@]}" --include=*.ts --include=*.tsx 2>/dev/null | head -2 | sed 's|^src/||' | tr '\n' ' ')
    printf "  OK       %-38s %s\n" "$ruta" "$ubicacion"
  else
    printf "  SIN USO  %-38s\n" "$ruta"
    printf "           ningun archivo de interfaz lo menciona. O se perdio el boton\n"
    printf "           en una refactorizacion, o el endpoint sobra y hay que borrarlo.\n"
    printf "           Si es a proposito, agregalo a EXCEPCIONES con el motivo.\n"
    fallos=$((fallos + 1))
  fi
done < <(find src/app/api -name route.ts | sort)

echo
echo "  revisados: $total"
echo

if [ "$fallos" -gt 0 ]; then
  echo "ACCIONES SIN BOTON: $fallos"
  exit 1
fi

echo "TODAS LAS ACCIONES SON ALCANZABLES"
