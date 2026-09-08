# T04 — `/api/jobs/[id]`: las 6 rutas, con el guard que reemplaza el lookup

- **Depende de:** T01 (importás `requireJobOwner` de `src/lib/ownership.ts`)
- **Bloquea:** T08
- **Se puede correr en paralelo con:** T02, T03, T05, T06, T07
- **Repo:** `/Users/lucho/Desktop/funnel/videogeneradorxd`
- **Archivos que este task puede tocar** (6, y ninguno más):

```
src/app/api/jobs/[id]/approve/route.ts    (POST)
src/app/api/jobs/[id]/unapprove/route.ts  (POST)
src/app/api/jobs/[id]/retry/route.ts      (POST)
src/app/api/jobs/[id]/prompt/route.ts     (POST)
src/app/api/jobs/[id]/extend/route.ts     (POST)
src/app/api/jobs/[id]/preview/route.ts    (GET)
```

Leé `00-PLAN-AISLAMIENTO-USUARIO.md` completo. Tu contrato es **§4** (`requireJobOwner` y
`JobOwnerCheck`) y **§5.2** (el patrón, que en tu caso **reemplaza** código en vez de agregarlo).

---

## 1. Por qué esta task es la que más importa

Los ids de job **son derivados y predecibles**:

```
imageJobId(projectId, imageId) = `${projectId}:img:${imageId}`
videoJobId(projectId, clipId)  = `${projectId}:vid:${clipId}`
```

(`src/lib/jobs/pipeline.ts:43-48`.) O sea que con un solo `projectId` — que hoy se consigue de la
lista sin filtrar de `/api/projects` — se pueden **construir todos los ids de job del proyecto**. Y
tus 6 rutas no son de lectura: aprueban, desaprueban, regeneran, editan prompts y extienden videos.
Sin guard, un projectId ajeno alcanza para **modificar y gastar** en el proyecto del otro, no solo
para mirarlo.

---

## 2. El patrón: reemplaza, no agrega

Tus 6 rutas ya empiezan igual (verificado en `approve/route.ts:19` y `preview/route.ts:37`):

```ts
// ANTES
const job = jobsDb.get(params.id);
if (!job) return notFound("Job no encontrado");

// DESPUES
const guard = requireJobOwner(params.id);
if (!guard.ok) return guard.response;
const job = guard.job;
```

`guard.job` **es** el `JobRecord` que devolvía `jobsDb.get()`. No hay segunda consulta a la DB y el
resto de la función no cambia: sigue habiendo un `job` con el mismo tipo.

Dos cosas que hacen que el diff observable sea cero para el caso legítimo:

- El 404 de job inexistente usa **el mismo mensaje** que hoy (`"Job no encontrado"`), así que la UI
  muestra exactamente el mismo cartel que antes.
- El 404 de job **ajeno** es idéntico al de inexistente (D4). No hay forma de distinguirlos desde
  afuera, que es el punto.

**Si después del cambio el archivo ya no usa `jobsDb`, sacá el import.** `tsc` con `noUnusedLocals`
puede no quejarse, pero un import muerto que apunta a un archivo intocable confunde al próximo que
lea la ruta. Fijate archivo por archivo: `preview/route.ts` **sí** sigue usando `projectsDb` y
`jobsDb.imageJob()`, así que ahí el import se queda.

---

## 3. Los 6 archivos

| Archivo | Lo que no es obvio |
|---|---|
| `approve/route.ts` | body opcional `{ index }` para elegir variante. El guard va **antes** de `req.json()` |
| `unapprove/route.ts` | vuelve un job aprobado a `awaiting_approval` |
| `retry/route.ts` | **regenera: vuelve a llamar al proveedor y vuelve a gastar.** Sin body |
| `prompt/route.ts` | cambia prompt/diálogo/duración/resolución/modelo, con `regenerate?` opcional. **Persiste en el PLAN** (`changePrompt`), o sea que sin guard uno reescribe el guion del VSL del otro y eso impacta el `.mp4` final |
| `extend/route.ts` | extiende el video +7s. Gasta |
| `preview/route.ts` | GET. **Devuelve el prompt exacto, la imagen de input y el JSON**: es lectura, pero es la lectura más sensible que hay. Ojo: este archivo hace `jobsDb.get()` **y** `projectsDb.get(job.projectId)` (líneas 37-40); el `projectsDb.get()` y su `notFound` se conservan |

---

## 4. Verificación

Nada de esto es opcional. Un task que no corre su verificación no está terminado, y "compila" no es
verificación.

```bash
cd /Users/lucho/Desktop/funnel/videogeneradorxd

# 1 — los 6 archivos usan el guard, uno por handler
for f in approve unapprove retry prompt extend preview; do
  p="src/app/api/jobs/[id]/$f/route.ts"
  h=$(grep -cE "^export async function (GET|POST)" "$p")
  g=$(grep -c "requireJobOwner(params.id)" "$p")
  printf "%-12s handlers=%s guards=%s\n" "$f" "$h" "$g"
done
# esperado exactamente: las 6 lineas con handlers=1 guards=1

# 2 — ya NADIE de tus rutas hace el lookup viejo suelto
grep -rn "jobsDb.get(params.id)" "src/app/api/jobs/[id]"/ || echo "el lookup viejo ya no esta"
# esperado exactamente: el lookup viejo ya no esta
#   Si aparece alguno, quedo el codigo duplicado: el guard ya trae el job.

# 3 — el job sale del guard, no de una segunda consulta
grep -rc "guard.job" "src/app/api/jobs/[id]"/*/route.ts | awk -F: '{s+=$2} END {print s}'
# esperado: 6 o mas (algun archivo puede usarlo mas de una vez)

# 4 — no quedaron imports muertos de jobsDb
#     `jobsDb.` con punto es un USO; `jobsDb` sin punto puede ser solo el import.
for f in approve unapprove retry prompt extend preview; do
  p="src/app/api/jobs/[id]/$f/route.ts"
  u=$(grep -c "jobsDb\." "$p")
  i=$(grep -c "jobsDb" "$p")
  [ "$u" -eq 0 ] && [ "$i" -gt 0 ] && echo "IMPORT MUERTO en $f"
done
# esperado exactamente: sin salida (ninguna linea "IMPORT MUERTO")
#   preview/route.ts SI debe seguir usando jobsDb.imageJob(): ahi no es import muerto.

# 5 — el guard va antes de leer el body
for f in approve prompt; do
  p="src/app/api/jobs/[id]/$f/route.ts"
  g=$(grep -n "requireJobOwner" "$p" | head -1 | cut -d: -f1)
  b=$(grep -n "req.json()" "$p" | head -1 | cut -d: -f1)
  [ -n "$b" ] && { [ "$g" -lt "$b" ] && echo "ok $f (guard $g < body $b)" || echo "REVISAR $f"; }
done
# esperado exactamente: 2 lineas "ok ...", ninguna "REVISAR"

# 6 — typecheck
rm -rf .next && npx tsc --noEmit
# esperado: sin salida, exit 0

# 7 — tus 6 rutas ya estan en verde
bash tasks/aislamiento-por-usuario/_verificacion-aislamiento.sh 2>&1 | grep -E "jobs/\[id\]/"
# esperado exactamente: 6 lineas, todas empezando con "OK"

# 8 — no rompiste ningun endpoint
bash tasks/_verificacion-endpoints.sh | tail -1
# esperado exactamente: SIN REGRESIONES
```

---

## 5. Cuándo parar

**Bloqueante, pará y avisá:**

- `requireJobOwner` no existe o no devuelve el `job` en el caso `ok: true`. Sin eso, cada ruta tendría
  que hacer una segunda consulta y el patrón de §5.2 no aplica. **No lo resuelvas con
  `jobsDb.get()` al lado del guard**: pará y avisá, porque significa que T01 se desvió del contrato.
- Encontrás que `requireJobOwner` **parsea el string del jobId** en vez de usar `jobsDb.get()`. Es la
  regla 4 de §4 y está así por un motivo (`imageId` sale del plan y puede contener `:`). Avisá.

**Anotalo en §10 del plan y seguí:**

- Una ruta acepta un jobId de un job que **todavía no existe** (los ids son derivados, así que la UI
  puede construir uno antes de que el job esté creado — ver `hasJob` en `src/lib/batch.ts`). Con el
  guard eso devuelve 404 en vez de crear nada. Anotalo con el path si ves que alguna pantalla dependía
  de ese comportamiento.
- Necesitás modificar un archivo ajeno → **nunca**; anotalo.
