#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Verificacion 3 de 3 — "no rompiste nada".
#
# Linea base capturada el 2026-08-28, ANTES de tocar una sola linea de UI.
#
#   bash tasks/_verificacion-endpoints.sh
#
# Salida esperada: "SIN REGRESIONES" y exit 0.
#
# ─── QUE PROBLEMA RESUELVE ───────────────────────────────────────────────────
#
# El rediseño es VISUAL. Ninguna pantalla tiene que dejar de llamar a un endpoint
# ni empezar a llamar a otro. Pero un agente reescribiendo 800 lineas de JSX puede
# perderse un `fetch` en el camino, y eso NO rompe el build ni el typecheck: rompe
# en runtime, en un boton que el usuario aprieta una vez por semana.
#
# Los casos reales que esto atrapa:
#   - se pierde el fetch de aprobar variante  -> el boton "Elegir v2" no hace nada
#   - se pierde el de regenerar               -> "Variar" no hace nada
#   - se pierde el DELETE del logout          -> el boton Salir no cierra sesion
#   - alguien "simplifica" y apunta a otra ruta
#
# Ninguno de esos tira un error visible. Por eso hay que contarlos a mano.
#
# NO valida que el fetch este bien escrito ni que se llame en el momento correcto:
# valida que la pantalla siga MENCIONANDO los mismos endpoints. Es un piso, no un
# techo. El circuito real se prueba a mano (§9 del plan, paso 7).
# ─────────────────────────────────────────────────────────────────────────────
set -u
cd "$(dirname "$0")/.." || exit 1

# Formato: archivo|endpoints separados por espacio, ordenados
#
# ─── ACTUALIZACION 2026-09-22: el rediseño del handoff movio fetch a proposito ──
#
# Cuatro movimientos, ninguno cambia un endpoint ni un payload:
#
#  1. `batch/review/ReviewDeck.tsx` + `batch/videos/VideoDeck.tsx` -> `batch/ReviewBoard.tsx`.
#     El handoff unifica las DOS pantallas de revision en una sola con un selector
#     Imagenes/Clips, asi que los dos decks pasaron a ser un componente compartido que
#     montan las dos rutas. De paso el GET a /api/batch quedo UNO en vez de dos: era
#     el mismo snapshot pedido dos veces.
#
#  2. `page.tsx` -> `HomeProyectos.tsx` + `NuevoProyectoWizard.tsx`. La home se partio
#     en el listado y el wizard de 3 pasos, y `page.tsx` quedo como el orquestador que
#     alterna entre los dos: no hace ni un fetch propio (por eso no figura mas abajo).
#
#  3. `HomeProyectos.tsx` AGREGA un GET a /api/batch?ids=. Es de SOLO LECTURA y el
#     endpoint ya existia (lo usan /batch y las dos vistas de revision). Hace falta
#     porque las cards nuevas muestran el mini-timeline de clips, las dos barras de
#     progreso y "N clips esperan tu aprobacion", y `GET /api/projects` no trae nada de
#     eso: devuelve solo id, name, status, fechas y los conteos del PLAN. Es
#     best-effort: si falla, la card cae a su version basica y el listado no se rompe.
#
#  4. `project/[id]/pipeline/page.tsx` mantiene sus tres endpoints (preview del job,
#     generate y approve-batch) y la ruta de archivos. Lo unico que cambio es que el
#     frame inicial del editor de clip puede llegar ya resuelto desde la timeline, asi
#     que el codigo chequea el prefijo COMPLETO de la ruta de archivos: un prefijo
#     pelado le figura a este script como un endpoint nuevo.
#
# Ninguna linea de abajo se toco "para que pase": cada cambio esta arriba con su
# motivo, y el conjunto de endpoints que la app llama es el mismo de antes mas el
# /api/batch de lectura del punto 3.
#
# ─── ACTUALIZACION 2026-09-25: cambio de voz (tasks/cambio-de-voz/) ─────────────
#
# Se AGREGA una linea, la de `src/components/CambiarVozDialog.tsx`: es un archivo
# NUEVO que llama a dos endpoints nuevos (/api/voces y /api/voces/favoritas) y al POST
# de /api/projects/:id/voz. Va en la linea base para que la proxima refactorizacion no
# le pueda sacar un fetch sin que esto salte. La linea de `result/page.tsx` NO cambia:
# su llamada a /voz cae en el prefijo /api/projects/, que ya estaba. Ninguna otra
# linea se toco.
LINEA_BASE=$(cat <<'BASE'
src/app/HomeProyectos.tsx|/api/batch /api/projects /api/projects/
src/app/NuevoProyectoWizard.tsx|/api/projects /api/projects/
src/app/SessionBar.tsx|/api/login
src/app/batch/BatchBoard.tsx|/api/batch /api/projects
src/app/batch/ReviewBoard.tsx|/api/batch /api/jobs/
src/app/imagenes/ImagenesBoard.tsx|/api/files/ /api/imagenes /api/jobs/ /api/projects /api/projects/
src/app/imagenes/page.tsx|/api/config
src/app/login/LoginForm.tsx|/api/login
src/app/project/[id]/pipeline/page.tsx|/api/files/ /api/jobs/ /api/projects/
src/app/project/[id]/result/page.tsx|/api/files/ /api/projects/
src/components/CambiarVozDialog.tsx|/api/projects/ /api/voces /api/voces/favoritas
src/components/JobCard.tsx|/api/files/ /api/prompt-template
src/store/useProjectStore.ts|/api/config /api/jobs/ /api/parse /api/projects/
BASE
)

extraer() {
  # `/api/imagenes/route` aparece solo en un comentario que cita el archivo de la
  # ruta; se normaliza para que no cuente como un endpoint distinto.
  grep -ohE '/api/[a-zA-Z0-9/_-]*' "$1" 2>/dev/null \
    | sed 's|/api/imagenes/route|/api/imagenes|' \
    | sort -u | tr '\n' ' ' | sed 's/ $//'
}

fallos=0
echo "═══ endpoints por archivo, contra la linea base pre-rediseño ═══"
echo

while IFS='|' read -r archivo esperado; do
  [ -z "$archivo" ] && continue

  if [ ! -f "$archivo" ]; then
    printf "  FALTA    %s\n" "$archivo"
    printf "           el archivo no existe. Si se renombro a proposito, actualizá\n"
    printf "           la LINEA_BASE de este script en el mismo commit.\n"
    fallos=$((fallos + 1))
    continue
  fi

  actual=$(extraer "$archivo")
  if [ "$actual" = "$esperado" ]; then
    printf "  OK       %s\n" "${archivo#src/}"
  else
    printf "  CAMBIO   %s\n" "${archivo#src/}"
    printf "           esperado: %s\n" "$esperado"
    printf "           actual:   %s\n" "${actual:-(ninguno)}"
    for e in $esperado; do
      case " $actual " in *" $e "*) ;; *) printf "           PERDIO:   %s\n" "$e" ;; esac
    done
    for a in $actual; do
      case " $esperado " in *" $a "*) ;; *) printf "           AGREGO:   %s\n" "$a" ;; esac
    done
    fallos=$((fallos + 1))
  fi
done <<< "$LINEA_BASE"

echo
echo "═══ los archivos que NADIE toca siguen intactos ═══"
INTOCABLES="src/lib/jobs/queue.ts src/lib/jobs/pipeline.ts src/lib/config.ts
src/lib/schema.ts src/lib/storage.ts src/lib/db.ts src/lib/auth.ts src/middleware.ts
src/lib/providers/vertex/image.ts src/lib/providers/vertex/video.ts"
for f in $INTOCABLES; do
  if [ ! -f "$f" ]; then
    printf "  FALTA %s\n" "$f"
    fallos=$((fallos + 1))
  fi
done
printf "  %s archivos intocables presentes\n" "$(echo "$INTOCABLES" | wc -w | tr -d ' ')"

echo
if [ "$fallos" -eq 0 ]; then
  echo "SIN REGRESIONES"
  exit 0
fi
echo "REGRESIONES: $fallos"
echo
echo "Si un cambio es intencional (se movio un fetch a otro archivo), actualizá la"
echo "LINEA_BASE en el mismo commit y explicá por que en el mensaje. Nunca la toques"
echo "para 'que pase'."
exit 1
