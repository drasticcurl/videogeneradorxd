# T06 — Archivos y lote: los dos caminos donde el id viene de afuera

- **Depende de:** T01 (importás `requireProjectOwner` y `filterOwnedIds`)
- **Bloquea:** T08
- **Se puede correr en paralelo con:** T02, T03, T04, T05, T07
- **Repo:** `/Users/lucho/Desktop/funnel/videogeneradorxd`
- **Archivos que este task puede tocar** (2, y ninguno más):

```
src/app/api/files/[...path]/route.ts   (GET)  → requireProjectOwner
src/app/api/batch/route.ts             (GET, POST) → filterOwnedIds
```

Leé `00-PLAN-AISLAMIENTO-USUARIO.md` completo. Tu contrato es **§4** y **§5.4**. Tus dos rutas usan
**helpers distintos y estrategias distintas**: una rechaza, la otra filtra. No las unifiques.

---

## 1. Por qué son dos casos distintos

| Ruta | De dónde viene el id | Qué hace | Por qué |
|---|---|---|---|
| `/api/files/<projectId>/<path>` | primer segmento de la URL | **rechaza** con 404 | es un archivo puntual: o es tuyo o no |
| `/api/batch?ids=a,b,c` | query string / body | **filtra** y sigue | es un lote de varios; si un id ajeno tirara 404, pegar una URL vieja con un id de más rompería el tablero entero en vez de mostrar los 5 que sí son tuyos (D6) |

---

## 2. `files/[...path]/route.ts` — el agujero más grande del módulo

**Leé el archivo completo antes de escribir.** Hoy hace exactamente esto (líneas 36-52):

1. `segments.length < 2` → 400.
2. `const [projectId, ...rest] = segments`.
3. `safeResolve(projectId, relPath)` → 403 si el path se escapa de la carpeta.
4. Sirve los bytes.

**Nunca consulta la DB.** `safeResolve` es anti path-traversal: impide salir de
`output/<projectId>/`, pero no tiene ninguna opinión sobre **de quién** es ese projectId. Con un
projectId, hoy se ven y se bajan todas las imágenes, todos los clips, el video unido y el
`manifest.json` completo del proyecto ajeno.

El guard va **después** del chequeo de largo y **antes** de `safeResolve`:

```ts
const guard = requireProjectOwner(projectId);
if (!guard.ok) return guard.response;
```

**Tres cosas de esta ruta que NO se cambian:**

1. **Sigue devolviendo `Response` con texto plano, no JSON.** El resto del archivo usa
   `new Response("No encontrado", { status: 404 })` y no los helpers de `@/lib/http`, porque sirve
   bytes. `guard.response` es un `NextResponse` con JSON — **está bien igual**: lo que consume esto son
   `<img src>` y `<video src>`, que miran el status y no el body. No lo "arregles" convirtiéndolo, y no
   cambies los otros `Response` del archivo a JSON.
2. **El soporte de Range se queda tal cual.** Es lo que hace que se pueda hacer seek en los videos.
3. **`safeResolve` se queda.** El guard es autorización, `safeResolve` es anti-traversal: son dos
   defensas distintas. Sacar una porque está la otra es el error clásico — un dueño legítimo con un
   path malicioso sigue necesitando `safeResolve`.

**El costo importa acá y en ningún otro lugar del módulo.** Esta ruta se llama muchas veces por
pantalla (una por miniatura). `requireProjectOwner` hace una lectura del singleton en memoria de
`db.ts`, no una lectura de disco, así que es barato — pero por eso mismo la regla 6 de §4 dice que
`ownership.ts` **no escribe**: un `save()` acá sería un `db.json` completo escrito por cada miniatura.

---

## 3. `batch/route.ts` — filtrar, y los rechazados a `missingIds`

**Leé el archivo completo.** El `GET` lee `ids` de la query y llama `buildBatchSnapshot(ids)`. El
`POST` lee `ids` del body, itera con `projectsDb.get(id)` por cada uno para ejecutar la acción, y al
final vuelve a llamar `buildBatchSnapshot(ids)`.

El patrón, en los dos handlers:

```ts
const { owned, rejected } = filterOwnedIds(ids);
const snap = buildBatchSnapshot(owned);
return ok({ ...snap, missingIds: [...snap.missingIds, ...rejected] });
```

Por qué así y no de otra forma:

- **`src/lib/batch.ts` no se toca.** Está en la lista de intocables. `buildBatchSnapshot` recibe la
  lista **ya filtrada** y no necesita saber que existen usuarios. Si el filtro viviera adentro,
  `batch.ts` tendría que importar `ownership.ts` y pasaría a depender de `next/headers`, que lo ataría
  al contexto de un request — hoy es una función pura sobre la DB.
- **Los rechazados van a `missingIds`, que ya existe** en `BatchSnapshot` y que `BatchBoard.tsx:596`
  ya renderiza. No inventes un campo nuevo: la UI ya sabe qué hacer con ese, y agregar
  `foreignIds` obligaría a tocar `batch.ts` (el tipo) y `BatchBoard.tsx` (que es de T07).
- **Ajenos e inexistentes se mezclan a propósito** (D4/D6). No los separes ni los ordenes distinto: la
  respuesta no puede permitir distinguir "no existe" de "no es tuyo".

En el **`POST`**, además: el loop de acciones itera sobre **`owned`**, no sobre los ids del body. Si
iterara sobre el body, la acción (aprobar, regenerar, cambiar de fase) se ejecutaría sobre proyectos
ajenos aunque el snapshot de la respuesta después los filtrara — el daño ya estaría hecho.

Sin sesión, `filterOwnedIds` devuelve todo en `rejected` (porque `sessionUser()` es `null`). Eso da un
snapshot vacío con status 200, y está bien: el middleware ya devuelve 401 antes de llegar acá, así que
este camino solo se alcanza con una cookie válida.

---

## 4. Verificación

Nada de esto es opcional. Un task que no corre su verificación no está terminado, y "compila" no es
verificación.

```bash
cd /Users/lucho/Desktop/funnel/videogeneradorxd

# 1 — files/ tiene el guard, y va antes de safeResolve
g=$(grep -n "requireProjectOwner" "src/app/api/files/[...path]/route.ts" | head -1 | cut -d: -f1)
s=$(grep -n "safeResolve" "src/app/api/files/[...path]/route.ts" | head -1 | cut -d: -f1)
[ "$g" -lt "$s" ] && echo "ok (guard $g < safeResolve $s)" || echo "REVISAR orden: guard $g, safeResolve $s"
# esperado exactamente: ok (guard <n> < safeResolve <m>)

# 2 — safeResolve NO se saco (las dos defensas se quedan)
grep -c "safeResolve" "src/app/api/files/[...path]/route.ts"
# esperado: 1 o mas. Si da 0, sacaste el anti path-traversal: volvé a ponerlo.

# 3 — el soporte de Range sigue ahi
grep -cE "(Content-Range|Accept-Ranges)" "src/app/api/files/[...path]/route.ts"
# esperado: 3 o mas (206 + los headers del 200)

# 4 — batch usa filterOwnedIds en los DOS handlers
grep -c "filterOwnedIds" src/app/api/batch/route.ts
# esperado exactamente: 2

# 5 — los rechazados se suman a missingIds
grep -nE "missingIds: \[" src/app/api/batch/route.ts
# esperado exactamente: 2 resultados (uno por handler)

# 6 — no se invento un campo nuevo en la respuesta
grep -nE "(foreignIds|ajenos|notYours|rejectedIds)" src/app/api/batch/route.ts || echo "sin campos nuevos"
# esperado exactamente: sin campos nuevos

# 7 — el POST itera sobre owned, no sobre los ids del body
grep -nE "for \(const .* of owned\)" src/app/api/batch/route.ts
# esperado: 1 resultado
#   Si el loop sigue sobre `ids`, la accion se ejecuta sobre proyectos ajenos (§3).

# 8 — batch.ts NO se toco
git diff --name-only src/lib/batch.ts | grep . && echo "ERROR: tocaste batch.ts" || echo "batch.ts intacto"
# esperado exactamente: batch.ts intacto

# 9 — typecheck
rm -rf .next && npx tsc --noEmit
# esperado: sin salida, exit 0

# 10 — tus 2 rutas en verde
bash tasks/aislamiento-por-usuario/_verificacion-aislamiento.sh 2>&1 \
  | grep -E "^\s+(OK|PENDIENTE).*(files/\[\.\.\.path\]|batch/route)"
# esperado exactamente: 2 lineas, las dos empezando con "OK"

# 11 — no rompiste ningun endpoint
bash tasks/_verificacion-endpoints.sh | tail -1
# esperado exactamente: SIN REGRESIONES
```

A mano, con la app corriendo y dos usuarios en `.env.local`:

1. Como A, abrí una imagen de un proyecto tuyo. Copiá la URL de `/api/files/...`.
2. Salí, entrá como B, pegá esa URL. **Tiene que dar 404.** Hoy da la imagen.
3. Como B, entrá a `/batch?ids=<un id de A>`. El tablero tiene que aparecer **sin** miniaturas y con
   el cartel de proyectos no disponibles.

---

## 5. Cuándo parar

**Bloqueante, pará y avisá:**

- `filterOwnedIds` no existe o no devuelve `{ owned, rejected }` → T01 no terminó. **No filtres a mano
  con `ownerOf()` en un `.filter()`**: quedarían dos formas distintas y una se va a desincronizar.
- Poner el guard en `files/` rompe la carga de imágenes **de un proyecto propio** (por ejemplo, porque
  `cookies()` no está disponible en ese handler). Es la ruta que sirve todo lo que la app muestra: si
  se rompe, no se ve nada. Pará y avisá.

**Anotalo en §10 del plan y seguí:**

- Encontrás otro lugar que sirva archivos por fuera de `/api/files/` (un `rewrite` en
  `next.config.js`, un `public/` con symlinks). Anotalo con el path: sería un quinto camino de fuga
  que el inventario no tiene.
- El cartel de `missingIds` te parece que quedó raro con ids ajenos adentro. **Es de T07**, no lo
  toques; anotalo si ves algo que T07 no pueda resolver solo.
- Necesitás modificar un archivo ajeno → **nunca**; anotalo.
