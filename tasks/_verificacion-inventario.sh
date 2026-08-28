#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Verificacion 1 de 3 — el inventario que el plan afirma que existe.
#
# Corrida y en verde el 2026-08-28. Cada task cita archivos concretos; si alguno
# no existe, el agente lo crea "de cero" y duplica algo que ya estaba. Esto lo
# atrapa antes de largar el primer agente.
#
#   bash tasks/_verificacion-inventario.sh
#
# Salida esperada: "INVENTARIO COMPLETO" y exit 0.
# ─────────────────────────────────────────────────────────────────────────────
set -u
cd "$(dirname "$0")/.." || exit 1

fallos=0

chequear() {
  if [ -e "$1" ]; then
    printf "  OK    %s\n" "$1"
  else
    printf "  FALTA %s\n" "$1"
    fallos=$((fallos + 1))
  fi
}

echo "═══ 1. Las 8 pantallas que se rediseñan ═══"
for f in \
  src/app/page.tsx \
  src/app/login/page.tsx \
  src/app/login/LoginForm.tsx \
  src/app/imagenes/page.tsx \
  src/app/imagenes/ImagenesBoard.tsx \
  src/app/batch/page.tsx \
  src/app/batch/BatchBoard.tsx \
  src/app/batch/review/page.tsx \
  src/app/batch/review/ReviewDeck.tsx \
  src/app/batch/videos/page.tsx \
  src/app/batch/videos/VideoDeck.tsx \
  src/app/project/\[id\]/pipeline/page.tsx \
  src/app/project/\[id\]/result/page.tsx
do chequear "$f"; done

echo
echo "═══ 2. Componentes compartidos existentes ═══"
for f in \
  src/components/JobCard.tsx \
  src/components/StatusBadge.tsx \
  src/components/ProjectTabs.tsx \
  src/components/ModelSelectorBar.tsx \
  src/components/CostEstimatePanel.tsx \
  src/components/LogPanel.tsx \
  src/components/JsonEditor.tsx \
  src/components/FlowGraph.tsx \
  src/app/SessionBar.tsx \
  src/app/batch/ClipTimeline.tsx
do chequear "$f"; done

echo
echo "═══ 3. Archivos de sistema que el rediseño toca ═══"
for f in \
  src/app/layout.tsx \
  src/app/globals.css \
  tailwind.config.ts \
  package.json \
  postcss.config.js
do chequear "$f"; done

echo
echo "═══ 4. Archivos que NADIE toca (tienen que existir para poder protegerlos) ═══"
for f in \
  src/lib/jobs/queue.ts \
  src/lib/jobs/pipeline.ts \
  src/lib/config.ts \
  src/lib/schema.ts \
  src/lib/storage.ts \
  src/lib/db.ts \
  src/lib/auth.ts \
  src/middleware.ts \
  src/lib/providers/vertex/image.ts \
  src/lib/providers/vertex/video.ts \
  src/lib/providers/vertex/llm.ts \
  src/lib/providers/vertex/auth.ts \
  deploy/deploy.sh \
  deploy/ecosystem.config.js
do chequear "$f"; done

echo
echo "═══ 5. El sistema de diseño que crea T01 ═══"
# Hasta que T01 corrio, esta seccion verificaba que estos tres NO existieran, para
# atrapar el caso de un agente duplicando algo ya hecho. T01 los creo, asi que ahora
# verifica lo contrario. Si alguno falta, las 11 tasks siguientes no compilan: todas
# importan de aca.
for f in src/components/ui/index.ts src/lib/ui-tokens.ts src/lib/cn.ts; do
  chequear "$f"
done
printf "  primitivas en ui/: %s (esperado 9 archivos + index)\n" \
  "$(find src/components/ui -name '*.tsx' 2>/dev/null | wc -l | tr -d ' ')"

echo
echo "═══ 6. Conteos, informativos ═══"
# Los numeros de referencia son PRE-T01, cuando se escribio el plan. Suben a medida
# que el rediseño avanza (T01 solo agrego 11 archivos), asi que no son un criterio de
# aprobacion: estan para ver la magnitud. Los dos ultimos tienen que BAJAR a cero
# cuando termine T12.
tsx_total=$(find src/app src/components -name "*.tsx" | wc -l | tr -d ' ')
lineas=$(find src/app src/components -name "*.tsx" -exec cat {} + | wc -l | tr -d ' ')
botones=$(grep -ro "<button" src/ | wc -l | tr -d ' ')
bg_accent=$(grep -ro "bg-accent" src/ | wc -l | tr -d ' ')
printf "  archivos .tsx:     %s   (pre-T01: 24)\n" "$tsx_total"
printf "  lineas de tsx:     %s   (pre-T01: 6545)\n" "$lineas"
printf "  <button a mano:    %s   (pre-T01: 91. Los que quedan son casos con imagen adentro)\n" "$botones"
# La expectativa original decia "T12 espera 0, es un alias viejo". Estaba MAL y la
# corrigio T12: el alias viejo era el `accent` indigo, pero §4 define `accent` como
# token de primera clase (el ambar), asi que `bg-accent` es uso legitimo. Los alias que
# T12 borro fueron `ink` y `panel`, y de esos no queda ninguno.
printf "  usos de bg-accent: %s   (token de §4, uso legitimo)\n" "$bg_accent"
printf "  usos de ink/panel: %s   (alias viejos: T12 espera 0)\n" \
  "$(grep -rcE '\b(bg|text|border|ring)-(ink|panel)\b' src/ 2>/dev/null | awk -F: '{s+=$2} END {print s+0}')"

echo
if [ "$fallos" -eq 0 ]; then
  echo "INVENTARIO COMPLETO"
  exit 0
fi
echo "FALLOS: $fallos"
exit 1
