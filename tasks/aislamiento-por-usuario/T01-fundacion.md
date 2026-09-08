# T01 — Fundación: el campo `owner`, el helper de autorización y el script de migración

- **Depende de:** nada
- **Bloquea:** T02, T03, T04, T05, T06, T07 y T08 — o sea todas. Declarás el contrato que importan.
- **Se puede correr en paralelo con:** **corre sola. No paralelizar con nada.**
- **Repo:** `/Users/lucho/Desktop/funnel/videogeneradorxd`
- **Archivos que este task puede tocar:** `src/lib/types.ts`, `src/lib/ownership.ts` (nuevo),
  `scripts/migrar-owner.mjs` (nuevo). Nada más.

Leé `00-PLAN-AISLAMIENTO-USUARIO.md` completo. Tu contrato es **§4**: las 5 firmas y las 6 reglas de
implementación. Copialas tal cual, **no las mejores** — hay 6 tasks que se escriben contra ellas al
mismo tiempo.

**Si esta task falla, se para el proyecto.** Todo lo demás importa de acá.

---

## 1. Objetivo

Cuando termines:

- `src/lib/types.ts` tiene `owner?: string` en `ProjectRecord`, con el comentario de §3 del plan.
- `src/lib/ownership.ts` existe y exporta exactamente `sessionUser`, `ownerOf`,
  `requireProjectOwner`, `requireJobOwner` y `filterOwnedIds`, más los tipos `OwnerCheck` y
  `JobOwnerCheck`.
- `scripts/migrar-owner.mjs` existe y es una copia **byte por byte** del script canónico.
- `npx tsc --noEmit` pasa. Ninguna ruta usa todavía el helper, y eso está bien.

**Este task no toca ninguna route handler, no cambia el login, y no corre la migración contra ningún
`db.json` real.**

---

## 2. Antes de escribir, leé estos cuatro archivos

| Archivo | Qué mirar | Qué NO copiar de ahí |
|---|---|---|
| `src/lib/types.ts` | dónde va `owner` dentro de `ProjectRecord`, y el estilo de los comentarios de los campos opcionales (`stage`, `imageSize`) | nada, es el archivo que editás |
| `src/lib/auth.ts` | `currentUser(cookies)` al final del archivo: recibe un objeto con `.get(name)`, no `cookies()` ya invocado | **no importes nada más de acá y no lo modifiques.** Es autenticación (D5) |
| `src/lib/db.ts` | la forma de `projectsDb.get()` y `jobsDb.get()`: devuelven `undefined`, no `null` | **no agregues métodos a `db.ts`.** Está en la lista de intocables |
| `src/lib/http.ts` | `notFound(message)` devuelve `{ error: message }` con status 404 | — |

De `src/app/api/login/route.ts` mirá una sola cosa: que `cookies()` de `next/headers` funciona dentro
de un route handler (líneas 11 y 88). Es lo que habilita la regla 1 de §4.

---

## 3. `src/lib/types.ts` — una línea y su comentario

Agregá `owner?: string` a `ProjectRecord`, con el comentario que está en §3 del plan. Ponelo cerca de
los otros opcionales (`autoApprove`, `stage`), no al final del todo.

**Es opcional a propósito y no lo cambies a obligatorio.** Si fuera obligatorio, `tsc` rompería en
todos los lugares que construyen un `ProjectRecord` y habría que arreglarlos acá, que es la colisión
que este plan evita (D2).

**No toques ningún otro tipo de este archivo.** `JobRecord` no lleva `owner` (D8).

---

## 4. `src/lib/ownership.ts` — el contrato, completo

Escribilo entero, con las 5 funciones y los 2 tipos de §4. Las firmas son contrato: 6 tasks se están
escribiendo contra ellas ahora mismo.

Arriba del archivo va un comentario de cabecera que explique **por qué existe separado de `auth.ts`**
(autenticación vs autorización, D5) y **qué agujero cierra** (los 4 caminos: `/api/projects` sin
filtrar, `/batch?ids=`, `/api/files/` que ni consulta la DB, y los ids de job derivados del
projectId). El estilo de comentario de este repo es ese: el por qué y el bug concreto.

Lo que no es obvio, función por función:

| Función | Lo que importa |
|---|---|
| `sessionUser()` | `currentUser(cookies())`, con `cookies()` de `next/headers`. Devuelve `null` si no hay sesión. Es el único lugar del módulo que importa `next/headers`: si cada ruta lo importara, 21 archivos dependerían de un detalle del runtime de Next |
| `ownerOf(projectId)` | `projectsDb.get(id)?.owner ?? null`. **Los dos casos (no existe / sin dueño) devuelven `null` a propósito**: ninguno habilita a nadie (D2) |
| `requireProjectOwner(id)` | sin sesión → 401. Inexistente **o** de otro → **el mismo** 404, armado con `notFound("Proyecto no encontrado")` |
| `requireJobOwner(jobId)` | resolvé el job con `jobsDb.get(jobId)` y sacá el proyecto de `job.projectId`. **Nunca parsees el string del id** (regla 4 de §4: `imageId` sale del plan y puede tener `:`). Job inexistente → `notFound("Job no encontrado")`, que es **el mismo mensaje que devuelven hoy** esas 6 rutas |
| `filterOwnedIds(ids)` | un solo `sessionUser()` para toda la lista, no uno por id. `rejected` mezcla ajenos e inexistentes (D6) |

Reglas que no se negocian, todas con el bug que evitan, en §4 del plan. Las dos que más se olvidan:

- **El helper lee la cookie por su cuenta**, no recibe el usuario como parámetro. Un call site que se
  olvida de pasarlo produce un chequeo que pasa siempre y es indetectable desde adentro.
- **`ownership.ts` LEE de `db.ts`, nunca escribe.** Un `save()` disparado desde acá correría en cada
  `GET /api/files/...`, que son cientos por pantalla.

**Detalle de tipos:** `projectsDb.get()` y `jobsDb.get()` devuelven `T | undefined`. El contrato usa
`null`. Convertilo explícito (`?? null`), no dejes que se filtre `undefined` en el tipo de retorno:
`string | null | undefined` obliga a chequear dos cosas en cada uno de los 21 call sites.

---

## 5. `scripts/migrar-owner.mjs` — copiar, no reescribir

```bash
cp tasks/aislamiento-por-usuario/_migracion-owner.mjs scripts/migrar-owner.mjs
```

**Es una copia literal. No lo reescribas, no lo "adaptes" y no le cambies los 4 nombres de Ivan.**
Ese archivo ya se ejecutó contra una base scratch y tiene 7 afirmaciones verificadas
(`_verificacion-migracion.mjs`). Si lo tipeás de nuevo, perdés las 7.

Lo único que podés hacer es dejarlo ejecutable (`chmod +x`). Si te parece que le falta algo, va a §10
del plan; no lo agregues.

---

## 6. Verificación

Nada de esto es opcional. Un task que no corre su verificación no está terminado, y "compila" no es
verificación.

```bash
cd /Users/lucho/Desktop/funnel/videogeneradorxd

# 1 — el contrato exporta los 5, con el nombre exacto
for s in sessionUser ownerOf requireProjectOwner requireJobOwner filterOwnedIds; do
  grep -q "export function $s" src/lib/ownership.ts && echo "ok $s" || echo "FALTA $s"
done
# esperado exactamente: 5 lineas "ok <nombre>", ningun "FALTA"

# 2 — los dos tipos del contrato tambien se exportan
grep -cE "export type (OwnerCheck|JobOwnerCheck)" src/lib/ownership.ts
# esperado exactamente: 2

# 3 — el campo owner esta en ProjectRecord y es OPCIONAL
grep -n "owner?: string" src/lib/types.ts
# esperado: 1 resultado. Si dice "owner: string" (sin ?), esta MAL: ver D2

# 4 — JobRecord NO tiene owner (D8)
sed -n '/export interface JobRecord/,/^}/p' src/lib/types.ts | grep -c owner
# esperado exactamente: 0

# 5 — requireJobOwner NO parsea el id (regla 4 de §4)
grep -nE '(split\(":"\)|\.split\(.:.\))' src/lib/ownership.ts || echo "no parsea el jobId"
# esperado exactamente: no parsea el jobId

# 6 — ownership.ts no escribe en la DB
grep -nE '\.(upsert|update|remove|save)\(' src/lib/ownership.ts || echo "solo lecturas"
# esperado exactamente: solo lecturas

# 7 — el script de migracion es una copia identica del canonico
diff tasks/aislamiento-por-usuario/_migracion-owner.mjs scripts/migrar-owner.mjs && echo "identico"
# esperado exactamente: identico

# 8 — la migracion sigue en verde (probas el script que acabas de copiar)
node tasks/aislamiento-por-usuario/_verificacion-migracion.mjs | tail -1
# esperado exactamente: TODO EN VERDE (7/7)

# 9 — typecheck
rm -rf .next && npx tsc --noEmit
# esperado: sin salida, exit 0

# 10 — el estado del modulo despues de T01
bash tasks/aislamiento-por-usuario/_verificacion-aislamiento.sh | grep -E "^ verde:"
# esperado exactamente:  verde: 10   pendiente: 21   FALLO: 0
#   Los 3 items del contrato pasan a verde y quedan las 21 rutas. Si te da
#   FALLO > 0, rompiste un invariante: leelo, no sigas.

# 11 — no rompiste ningun endpoint
bash tasks/_verificacion-endpoints.sh | tail -1
# esperado exactamente: SIN REGRESIONES
```

**El paso 10 es la compuerta.** Hasta que dé `verde: 10   pendiente: 21   FALLO: 0`, la ola 2 no
arranca.

---

## 7. Cuándo parar

**Bloqueante, pará y avisá:**

- Alguna de las 5 firmas de §4 **no se puede implementar como está**. **No la cambies**: hay 6 tasks
  escritas contra ella. Pará y avisá — es lo que invalida el diseño entero.
- `cookies()` de `next/headers` no funciona dentro de `src/lib/ownership.ts` (por ejemplo, porque Next
  lo trata como módulo de cliente al importarse desde algún lado). Es el supuesto sobre el que están
  construidas las 21 rutas. Pará: la alternativa (pasar el usuario como parámetro) cambia las 6 tasks.
- El typecheck falla por algo que no es tu código.

**Anotalo en §10 del plan y seguí:**

- Te parece que falta un helper (por ejemplo `requireOwnerOrRedirect` para páginas). Anotalo, no lo
  agregues: si nadie lo pidió, ninguna task lo va a usar.
- Encontrás una ruta que recibe un projectId y **no está** en la tabla de §7. Anotala con el path
  exacto: significa que el inventario de 21 quedó corto.
- Necesitás modificar un archivo ajeno → **nunca**; anotalo.
