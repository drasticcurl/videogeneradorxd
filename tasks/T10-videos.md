# T10 — Deck de videos

- **Depende de:** T01, T02, T03
- **Bloquea:** nada
- **Se puede correr en paralelo con:** T09, T11
- **Repo:** `/Users/lucho/Desktop/funnel/videogeneradorxd`
- **Archivos que este task puede tocar:** `src/app/batch/videos/page.tsx`,
  `src/app/batch/videos/VideoDeck.tsx`. Nada más.

Leé `00-PLAN-REDISENO-UI.md` completo. Contratos: **§5**, **§6**.

**Task de riesgo alto.** Un video de 8 segundos cuesta varios dólares, así que un botón de regenerar
mal conectado, o peor, uno que se dispara solo, se paga.

---

## 1. Objetivo

17 + 628 líneas rediseñadas: la revisión de los videos generados.

**Esta task no cambia los 4 endpoints ni la lógica de regeneración.**

---

## 2. Antes de escribir

**Leé `VideoDeck.tsx` completo.** Anotá:

1. Los **4 endpoints** y qué payload manda cada uno.
2. **Cómo se cargan los videos.** Con 95 clips esto es lo que hace o rompe la pantalla: si monta 95
   `<video>` con `preload="auto"`, el browser se arrastra. Verificá qué hace hoy y **no lo empeores**.
3. Si hay reproducción bajo demanda (click para cargar), **conservala**: está ahí por rendimiento.

---

## 3. La estructura nueva

1. **Grilla de videos** en `aspect-[9/16]`, con `poster` y `preload="none"`.
2. **El estado de cada uno** con `Badge`. El de `generating` es el único que pulsa.
3. **Regenerar como acción secundaria y con confirmación**: usá el `Dialog` de T01 y decí en el
   diálogo que cuesta plata. Hoy es un click directo. **Esto es lo único que agrego como cambio de
   comportamiento y está justificado**: un click accidental en una grilla densa cuesta dólares. Si te
   parece que molesta, anotalo en §10.
4. **`EmptyState`** cuando el proyecto no tiene videos.

---

## 4. Rendimiento, que acá es un requisito

- `preload="none"` en todos los `<video>`.
- Nada de `autoplay`.
- Un solo elemento animado en pantalla como máximo (el pulso de `generating`).
- Si la grilla tiene más de 40 items, verificá el scroll en el browser antes de dar por terminada la
  task. Si lagea, decilo en §10 con el número.

---

## 5. Verificación

```bash
cd /Users/lucho/Desktop/funnel/videogeneradorxd

# 1 — typecheck y build
rm -rf .next && npx tsc --noEmit && npm run build 2>&1 | tail -3
# esperado exactamente: tsc sin salida (exit 0), y el build imprime "Compiled successfully"

# 2 — la ruta sigue
npm run build 2>&1 | grep "batch/videos"
# esperado: /batch/videos en la lista

# 3 — endpoints
bash tasks/_verificacion-endpoints.sh
# esperado exactamente: SIN REGRESIONES

# 4 — el conteo de fetch no bajo
grep -c "fetch(" src/app/batch/videos/VideoDeck.tsx
# esperado: 4

# 5 — ningun video precarga
grep -cE 'preload="none"' src/app/batch/videos/VideoDeck.tsx
# esperado: >= 1, y NO tiene que haber ningun preload="auto"
grep -c 'preload="auto"\|autoPlay' src/app/batch/videos/VideoDeck.tsx
# esperado exactamente: 0

# 6 — no invadiste ownership
git diff --name-only src/app/batch/review/ src/app/batch/BatchBoard.tsx
# esperado: sin salida

# 7 — cero colores literales
grep -rE "#[0-9a-fA-F]{3,6}" src/app/batch/videos/ || echo "limpio"
# esperado exactamente: limpio
```

A mano:

1. Abrí un proyecto con videos. Reproducí uno.
2. Apretá regenerar: **tiene que aparecer la confirmación**, y cancelarla no tiene que disparar nada.
3. Confirmá una sola regeneración y verificá que el estado pasa a `Generando`.
4. Con el VSL de 95 clips, scrolleá la grilla completa. Si lagea, anotalo.

---

## 6. Cuándo parar

**Bloqueante, pará y avisá:**

- El conteo de `fetch` baja de 4.
- Regenerar se dispara sin confirmación, o se dispara más de una vez por click. **Esto cuesta plata:
  pará.**

**Anotalo en §10 y seguí:** si la confirmación molesta en el uso real. Si la grilla lagea, con el
número de items. Necesitás modificar un archivo ajeno → nunca; anotalo.
