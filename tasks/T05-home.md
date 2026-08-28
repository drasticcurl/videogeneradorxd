# T05 — Home: brief, pegar JSON y avatares de referencia

- **Depende de:** T01, T02 (`ModelSelectorBar`, `CostEstimatePanel`, `JsonEditor`)
- **Bloquea:** nada
- **Se puede correr en paralelo con:** T04, T06
- **Repo:** `/Users/lucho/Desktop/funnel/videogeneradorxd`
- **Archivos que este task puede tocar:** `src/app/page.tsx`. **Uno solo, 805 líneas.**

Leé `00-PLAN-REDISENO-UI.md` completo. Contratos: **§5** y la lista de intocables de **§8**, donde
está `src/store/useProjectStore.ts`.

---

## 1. Objetivo

805 líneas reescritas: el punto de entrada de la app, con dos modos (interpretar un brief con la LLM,
o pegar un PlanJSON) más el panel de avatares de referencia y la lista de proyectos.

**Esta task no toca el store, no cambia los endpoints, y no cambia la lógica de los dos modos.**

---

## 2. Antes de escribir

**Leé `src/app/page.tsx` completo** y anotá:

1. Los **5 endpoints** que llama (`/api/projects` y `/api/projects/:id`, más lo que pase por el
   store: `/api/parse`, `/api/config`).
2. **Cómo funciona el panel de avatares de referencia.** Es lo más delicado de esta pantalla: sube
   fotos, permite editar el `id` de cada una con un indicador ✓/•, y ese `id` es el que el PlanJSON
   referencia en `ref_image_ids`. Si se rompe el mapeo, el VSL genera caras equivocadas.
3. Qué hace el store y qué hace la página. **`useProjectStore.ts` es intocable** (§8): tiene el
   polling y la forma de datos que consumen 4 pantallas.

Lo que **no** copiar: los colores literales, el `max-w-6xl` y la maraña de `text-xs`.

---

## 3. La estructura nueva

El problema de esta pantalla hoy es que los dos modos, los avatares y la lista de proyectos compiten
por la misma jerarquía. La estructura:

1. **Elección de modo** arriba, con `Tabs`: "Interpretar brief" y "Pegar JSON". Hoy se distingue mal
   en qué modo estás.
2. **El área de trabajo del modo elegido**, que es lo que ocupa el espacio.
3. **Avatares de referencia** en su propio bloque, visible en los dos modos como ahora.
4. **Modelos y costo estimado** juntos, cerca del botón de generar: son la información que necesitás
   justo antes de gastar plata.
5. **Proyectos recientes** al final, en grilla, con `EmptyState` cuando no hay ninguno. Hoy queda un
   hueco en blanco.

**No** uses tres tarjetas iguales en fila para nada: es el layout más genérico que existe.

---

## 4. Los estados que hoy faltan

| Estado | Qué mostrar |
|---|---|
| Sin proyectos | `EmptyState` con el texto de qué hacer, no un hueco |
| Cargando la lista | `Skeleton` con la forma de la grilla, no un spinner |
| `/api/parse` en curso | El botón en `loading`. **Puede tardar 15 a 20 segundos**: si no hay feedback, el usuario aprieta dos veces |
| El brief está vacío | Botón deshabilitado, y decir por qué |
| El JSON pegado es inválido | El error del validador **abajo del textarea**, con el detalle que devuelve la API |

---

## 5. Verificación

```bash
cd /Users/lucho/Desktop/funnel/videogeneradorxd

# 1 — typecheck y build
rm -rf .next && npx tsc --noEmit && npm run build 2>&1 | tail -3
# esperado exactamente: tsc sin salida (exit 0), y el build imprime "Compiled successfully"

# 2 — la home sigue compilada
npm run build 2>&1 | grep -E "^┌ ƒ /$|^├ ƒ /$"
# esperado: la ruta / en la lista

# 3 — los 5 endpoints siguen
bash tasks/_verificacion-endpoints.sh
# esperado exactamente: SIN REGRESIONES

# 4 — no tocaste el store
git diff --name-only src/store/
# esperado: sin salida

# 5 — cero colores literales, cero tipografia por debajo de 12px
grep -E "#[0-9a-fA-F]{3,6}|text-\[1[01]px\]" src/app/page.tsx || echo "limpio"
# esperado exactamente: limpio
```

A mano, y el punto 3 es el crítico:

1. Modo brief: pegá un brief de 2 escenas y generá. Tiene que aparecer el plan y la estimación.
2. Modo JSON: pegá algo inválido. El error tiene que salir abajo del campo y ser legible.
3. **Avatares:** subí una foto, editá su `id`, y verificá que el indicador ✓/• responde y que el `id`
   editado es el que queda en el plan. Si esto se rompe, el VSL genera la cara equivocada.
4. Sin proyectos (o con la lista vacía): tiene que verse el `EmptyState`.

---

## 6. Cuándo parar

**Bloqueante, pará y avisá:**

- El panel de avatares no se puede reproducir sin tocar el store.
- El punto 3 de la verificación a mano falla.

**Anotalo en §10 y seguí:**

- Necesitás un dato del store que no expone. **No lo agregues:** anotalo.
- Necesitás modificar un archivo ajeno → nunca; anotalo.
