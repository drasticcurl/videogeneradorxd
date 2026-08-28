# T02 — Los 8 componentes compartidos, sobre las primitivas

- **Depende de:** T01 (primitivas de §5 y `ui-tokens` de §6)
- **Bloquea:** T05, T06, T07, T08, T09, T10, T11, T12. Las siete pantallas importan al menos uno de
  estos componentes, y T12 no puede cerrar el QA hasta que estén.
- **Se puede correr en paralelo con:** T03
- **Repo:** `/Users/lucho/Desktop/funnel/videogeneradorxd`
- **Archivos que este task puede tocar:** `src/components/StatusBadge.tsx`, `ProjectTabs.tsx`,
  `ModelSelectorBar.tsx`, `CostEstimatePanel.tsx`, `LogPanel.tsx`, `JsonEditor.tsx`,
  `FlowGraph.tsx`, `src/app/SessionBar.tsx`. Nada más.

Leé `00-PLAN-REDISENO-UI.md` completo. Tu contrato es **§5 y §6**: las primitivas y el mapeo de
estados ya existen, los usás tal cual.

---

## 1. Objetivo

Los 8 componentes reescritos sobre las primitivas, **con las mismas props que tienen hoy**. Son
consumidos por 7 pantallas que se están escribiendo en paralelo: si cambiás una firma, rompés tasks
de otra ola.

**Esta task no cambia ninguna prop, no agrega ni saca funcionalidad, y no toca ninguna pantalla.**

---

## 2. La regla que gobierna toda esta task

**Antes de tocar cada archivo, leelo completo y anotá su interfaz de props.** Esa interfaz es
contrato. Lo que cambia es el JSX de adentro, no lo que entra ni lo que sale.

Si un componente hoy recibe `className` y lo compone, tiene que seguir haciéndolo: hay pantallas que
le pasan clases de posicionamiento.

---

## 3. `StatusBadge.tsx` — el que más importa

Hoy son 36 líneas con su propio `switch` de estados. **Ese switch es una de las 4 copias divergentes
que el plan quiere eliminar** (§6): es la razón de que `awaiting_approval` se vea de un color en una
pantalla y de otro en otra.

Reemplazalo por: `estadoDeJob(status)` de `ui-tokens` para obtener `{tone, label, animado}`, y
`<Badge tone={...}>`. El componente queda en ~12 líneas.

**Conservá la prop que tiene hoy.** Si recibe `status: JobRecord["status"]`, sigue recibiendo eso.

---

## 4. `ProjectTabs.tsx`

35 líneas. Reescribir sobre el `Tabs` de T01 (Radix). Gana navegación con flechas del teclado, que hoy
no tiene.

Cuidado: si las pestañas hoy se controlan por estado del padre, **seguí controlándolas igual**. Radix
soporta controlado y no controlado; el modo tiene que ser el que ya usa la pantalla.

---

## 5. `ModelSelectorBar.tsx`

121 líneas, tres selectores (chat, imagen, video). Es donde se ven las etiquetas con emoji que
pusimos en `MODEL_CATALOG`. Reescribir con el `Select` de T01, que muestra el desplegable estilado.

**No toques `src/lib/config.ts`** para cambiar una etiqueta: está en la lista de intocables. Las
etiquetas vienen del catálogo tal cual.

El `hint` de cada opción (el texto chico que explica) sale del `label` del catálogo si ya lo trae; no
inventes textos nuevos.

---

## 6. `CostEstimatePanel.tsx`

41 líneas. Los números van en `font-mono` con `.tnum` (D4): hoy están en proporcional y **bailan de
ancho cuando el polling actualiza**, que es exactamente el caso que el mono resuelve.

Agregá la palabra "estimado" al título. Ver **P-02** del plan: el precio por segundo de video quedó
desactualizado y el panel sobreestima. **No corrijas la aritmética**, que es config de otro dominio.

---

## 7. `LogPanel.tsx`

46 líneas. Es una lista de eventos con nivel (`info`, `warn`, `error`, `success`). Usá `tone` de
`ui-tokens` para el color del nivel, no un switch propio.

Los timestamps en `font-mono`. La lista con scroll y `divider` entre entradas, no `border` (D3: un
separador decorativo no necesita pasar 3:1).

---

## 8. `JsonEditor.tsx`

87 líneas. **Conservá la clase `.code`**: está definida en `globals.css` y T01 la mantuvo justamente
porque este componente la usa por nombre.

Es un `<textarea>` con validación. Envolvelo en el `Textarea` de T01 para ganar label y error, pero
**la lógica de parseo y validación no se toca**.

---

## 9. `FlowGraph.tsx`

86 líneas que dibujan el grafo de dependencias. **Migralo a los tokens nuevos sin cambiar la
estructura.** Ver **P-03** del plan: puede no valer la pena con 95 clips, pero eso se decide con un
dato, no de prepo.

**Anotá en §10 del plan cuántos nodos renderiza** con el VSL real de 95 clips
(`vsl-natalia-plan.json` está en la raíz). Ese número es lo que falta para decidir.

---

## 10. `SessionBar.tsx`

50 líneas. El nombre del usuario y el botón Salir. Reescribir con `Button variant="ghost"`.

**No toques la lógica del logout.** El `window.location.assign("/login")` está ahí por un bug
concreto y documentado en el propio archivo: `router.refresh()` sobre una ruta que el middleware va a
redirigir es lo que rompía el login. Leé ese comentario antes de "mejorarlo".

---

## 11. Verificación

```bash
cd /Users/lucho/Desktop/funnel/videogeneradorxd

# 1 — typecheck: si cambiaste una prop sin querer, revienta acá
rm -rf .next && npx tsc --noEmit
# esperado: sin salida, exit 0

# 2 — build
npm run build 2>&1 | tail -3
# esperado: termina sin "Failed to compile"

# 3 — no queda ningun switch de estados fuera de ui-tokens
grep -rn "awaiting_approval" src/components/ | grep -v "ui-tokens"
# esperado: sin resultados (el unico lugar que menciona los estados es ui-tokens)

# 4 — cero colores literales
grep -rE "#[0-9a-fA-F]{3,6}" src/components/*.tsx src/app/SessionBar.tsx || echo "sin colores literales"
# esperado exactamente: sin colores literales

# 5 — no rompiste endpoints (SessionBar llama al logout)
bash tasks/_verificacion-endpoints.sh
# esperado exactamente: SIN REGRESIONES

# 6 — las props no cambiaron: los consumidores siguen compilando
grep -rn "StatusBadge\|ProjectTabs\|ModelSelectorBar\|CostEstimatePanel" src/app/ | wc -l
# esperado: > 0, y el typecheck del paso 1 ya probo que las llamadas siguen validas
```

A mano: entrá a `/batch` y a un pipeline. Los badges de estado tienen que mostrar el label en
castellano (no `awaiting_approval` crudo) y el mismo color para el mismo estado en las dos pantallas.
Probá el botón Salir: tiene que cerrar sesión y llevarte al login.

---

## 12. Cuándo parar

**Bloqueante, pará y avisá:**

- Una primitiva de T01 no alcanza para reproducir el comportamiento actual de un componente **sin
  cambiar su firma**. No cambies la firma: 7 pantallas dependen de ella.
- El typecheck falla en un archivo que no es tuyo: significa que cambiaste una prop.

**Anotalo en §10 y seguí:**

- El conteo de nodos de `FlowGraph` con 95 clips (P-03). **Esto sí anotalo, es lo que falta para
  decidir.**
- Un componente que te parece que sobra o que se solapa con otro.
- Necesitás modificar un archivo ajeno → nunca; anotalo.
