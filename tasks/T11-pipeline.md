# T11 — Pipeline: el archivo más grande y el de mayor riesgo

- **Depende de:** T01, T02, T03
- **Bloquea:** a T12 (limpieza final)
- **Se puede correr en paralelo con:** T09, T10
- **Repo:** `/Users/lucho/Desktop/funnel/videogeneradorxd`
- **Archivos que este task puede tocar:** `src/app/project/[id]/pipeline/page.tsx`. **Uno solo, 1187
  líneas.**

Leé `00-PLAN-REDISENO-UI.md` completo. Contratos: **§5**, **§6** y la tabla de **§3**.

**Es la task más riesgosa del módulo.** Tiene tres vistas, un storyboard editable, y es donde se
guardan las ediciones del plan que después lee el export a ffmpeg. Va al final por eso.

---

## 1. Objetivo

1187 líneas rediseñadas, conservando las **tres vistas** y el storyboard editable.

**Esta task no cambia los 3 endpoints, no cambia qué se guarda en el plan, y no toca el store ni
`src/lib/`.**

---

## 2. Antes de escribir, y leelo entero

Son 1187 líneas y **hay que leerlas todas** antes de tocar una. Los componentes internos:

| Componente | Línea aprox. | Qué hace |
|---|---|---|
| `PipelinePage` | 30 | el contenedor y las 3 vistas |
| `Group` / `Filmstrip` | 405 / 453 | la vista agrupada |
| `FixView` / `FixRow` | 511 / 690 | la vista "Revisar / Arreglar", compacta, con video on-demand |
| `statusPill` | 673 | **el switch de estados local. Esto se reemplaza por `ui-tokens`.** |
| `ReviewStoryboard` / `ReviewCard` | 799 / 854 | el storyboard editable |
| `SavePayload` | 21 | **la forma de lo que se guarda al plan. NO la cambies.** |

Lo crítico, del steering del proyecto: **el export a ffmpeg lee del PLAN, no de los jobs.** Cualquier
edición tiene que seguir persistiendo vía el endpoint que ya se usa. Si el guardado se rompe, las
ediciones se pierden en silencio y aparecen recién en el video final.

Y: **si el proyecto tiene más de 24 clips, el pipeline arranca directo en `FixView`.** Ese
comportamiento se conserva; es lo que hace usable el VSL de 95 clips.

---

## 3. La estructura nueva

Las tres vistas se mantienen, con `Tabs` de T01 en lugar de lo que use hoy:

1. **Vista general**: progreso por etapa y los grupos.
2. **Revisar / Arreglar** (`FixView`): la lista compacta. **Sigue siendo la que aguanta 95 clips**:
   video on-demand, sin montar todos.
3. **Storyboard** (`ReviewStoryboard`): las tarjetas editables con prompt, diálogo, duración y el
   prompt final read-only.

En el storyboard, el orden de lo que se ve: la imagen de entrada, el prompt visual editable, el
diálogo editable, el selector de duración, y colapsados el prompt final y el JSON.

**`statusPill` se borra** y se reemplaza por `Badge` + `estadoDeJob`. Es una de las 4 copias
divergentes que el plan elimina.

---

## 4. Los tres botones de guardado

Existen tres y hacen cosas distintas. **Conservá los tres y que se distingan visualmente:**

| Botón | Qué hace | Variante |
|---|---|---|
| Guardar | persiste al plan, **sin** regenerar | `secondary` |
| Guardar y regenerar | persiste **y** vuelve a generar (cuesta plata) | `secondary` |
| Regenerar todos sin editar | regenera el lote (cuesta **mucha** plata) | `danger` |

El tercero con confirmación por `Dialog`, diciendo cuántos jobs va a regenerar. Hoy es un click
directo sobre algo que puede costar decenas de dólares en un VSL de 95 clips.

---

## 5. Verificación

```bash
cd /Users/lucho/Desktop/funnel/videogeneradorxd

# 1 — typecheck y build
rm -rf .next && npx tsc --noEmit && npm run build 2>&1 | tail -3
# esperado exactamente: tsc sin salida (exit 0), y el build imprime "Compiled successfully"

# 2 — la ruta sigue
npm run build 2>&1 | grep "pipeline"
# esperado: /project/[id]/pipeline en la lista

# 3 — endpoints
bash tasks/_verificacion-endpoints.sh
# esperado exactamente: SIN REGRESIONES

# 4 — el conteo de fetch no bajo
grep -c "fetch(" "src/app/project/[id]/pipeline/page.tsx"
# esperado: 3

# 5 — las tres vistas siguen existiendo
grep -cE "FixView|ReviewStoryboard" "src/app/project/[id]/pipeline/page.tsx"
# esperado: >= 2

# 6 — el corte de 24 clips sigue
grep -n "24" "src/app/project/[id]/pipeline/page.tsx"
# esperado: al menos una linea con el umbral. Si desaparecio, el VSL de 95 clips
#           arranca en la vista pesada y la pantalla se arrastra.

# 7 — el switch local de estados se fue
grep -c "statusPill" "src/app/project/[id]/pipeline/page.tsx"
# esperado exactamente: 0

# 8 — cero colores literales
grep -E "#[0-9a-fA-F]{3,6}" "src/app/project/[id]/pipeline/page.tsx" || echo "limpio"
# esperado exactamente: limpio
```

A mano, con el VSL real, y **sin saltear el punto 3**:

1. Abrí un proyecto de más de 24 clips: tiene que arrancar en `FixView`, no en el storyboard.
2. Cambiá entre las tres vistas.
3. **Editá un prompt visual y dale Guardar (sin regenerar). Recargá la página. El cambio tiene que
   seguir ahí.** Si no está, el guardado al plan se rompió, y eso no se ve hasta el video final.
4. Editá el diálogo y la duración de un clip, guardá, y verificá que el prompt final read-only se
   recalcula.
5. "Regenerar todos" tiene que pedir confirmación y decir el número.
6. Scrolleá `FixView` con 95 clips. Si lagea, el video on-demand se rompió.

---

## 6. Cuándo parar

**Bloqueante, pará y avisá:**

- El punto 3 de la verificación a mano falla. **Es el peor bug posible de esta task:** las ediciones
  se pierden y solo se descubre en el video exportado.
- `SavePayload` tendría que cambiar de forma.
- El conteo de `fetch` baja de 3.
- Se pierde el corte de 24 clips.

**Anotalo en §10 y seguí:** si las tres vistas te parecen dos. Si el storyboard necesita paginación.
Necesitás modificar un archivo ajeno → nunca; anotalo.
