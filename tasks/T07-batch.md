# T07 — Tablero de lotes

- **Depende de:** T01, T02, T03 (`JobCard`)
- **Bloquea:** nada
- **Se puede correr en paralelo con:** T08
- **Repo:** `/Users/lucho/Desktop/funnel/videogeneradorxd`
- **Archivos que este task puede tocar:** `src/app/batch/page.tsx`,
  `src/app/batch/BatchBoard.tsx`, `src/app/batch/ClipTimeline.tsx`. Nada más.

Leé `00-PLAN-REDISENO-UI.md` completo. Contratos: **§5**, **§6**.

**Ojo con el ownership:** `src/app/batch/review/page.tsx` y `src/app/batch/videos/page.tsx` son de
T09 y T10. Vos tocás **solo** el `page.tsx` que está directamente en `batch/`.

---

## 1. Objetivo

20 + 736 + 91 líneas rediseñadas. Es la vista de conjunto: todos los proyectos, su progreso y el
acceso a las otras dos vistas del lote.

**Esta task no cambia los endpoints ni la lógica de selección de proyecto.**

---

## 2. Antes de escribir

**Leé `BatchBoard.tsx` completo** y anotá:

1. Los endpoints: `/api/batch` y `/api/projects`.
2. Qué hacen `ProjectCard`, `Progress` y `ProjectPicker`, que son componentes internos del archivo.
   Se pueden reorganizar pero **no** moverlos a `src/components/`: ese directorio es de T02.
3. Cómo se resuelve el proyecto activo. Si viene de la URL, **no cambies el nombre del parámetro**.

---

## 3. La estructura nueva

El problema hoy es que el progreso y la identidad del proyecto compiten. La jerarquía:

1. **Selector de proyecto** arriba, con `Select`. Con muchos proyectos, la lista actual es incómoda.
2. **El progreso del proyecto activo** como la información dominante: cuántos jobs en cada estado,
   con los colores de `ui-tokens` y los números en mono.
3. **Accesos a Revisar y Videos** como acciones claras, no como links perdidos.
4. **Grilla de proyectos** con su progreso resumido.

`Progress`: usá una barra sin track de fondo relleno, segmentada por estado. Los números al lado, en
mono. Un track gris relleno con una porción de color es ruido de dashboard.

**`EmptyState`** cuando no hay proyectos: hoy queda en blanco.

---

## 4. `ClipTimeline.tsx`

91 líneas. Migralo a tokens. Si muestra los clips en una línea de tiempo horizontal, revisá que con 95
clips siga siendo usable: si no lo es, **anotalo en §10** con el número de clips a partir del cual se
rompe. No lo rediseñes de cero por tu cuenta.

---

## 5. Verificación

```bash
cd /Users/lucho/Desktop/funnel/videogeneradorxd

# 1 — typecheck y build
rm -rf .next && npx tsc --noEmit && npm run build 2>&1 | tail -3
# esperado exactamente: tsc sin salida (exit 0), y el build imprime "Compiled successfully"

# 2 — las tres rutas de batch siguen compiladas (las otras dos son de T09 y T10)
npm run build 2>&1 | grep -E "/batch"
# esperado: /batch, /batch/review y /batch/videos en la lista

# 3 — endpoints
bash tasks/_verificacion-endpoints.sh
# esperado exactamente: SIN REGRESIONES

# 4 — no invadiste el ownership de T09 ni T10
git diff --name-only src/app/batch/review/ src/app/batch/videos/
# esperado: sin salida

# 5 — cero colores literales
grep -rE "#[0-9a-fA-F]{3,6}" src/app/batch/*.tsx src/app/batch/ClipTimeline.tsx || echo "limpio"
# esperado exactamente: limpio
```

A mano: con un proyecto que tenga jobs en varios estados, el resumen de progreso tiene que sumar bien
y los colores tienen que coincidir con los de las tarjetas. Cambiá de proyecto con el selector y
verificá que el tablero se actualiza.

---

## 6. Cuándo parar

**Bloqueante, pará y avisá:** el selector de proyecto no se puede reproducir sin tocar el store.

**Anotalo en §10 y seguí:** el límite de clips a partir del cual `ClipTimeline` deja de ser usable.
Necesitás modificar un archivo ajeno → nunca; anotalo.
