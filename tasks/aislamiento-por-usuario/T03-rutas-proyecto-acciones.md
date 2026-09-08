# T03 — `/api/projects/[id]`: las 5 rutas de acciones y archivos

- **Depende de:** T01 (importás `requireProjectOwner` de `src/lib/ownership.ts`)
- **Bloquea:** T08
- **Se puede correr en paralelo con:** T02, T04, T05, T06, T07
- **Repo:** `/Users/lucho/Desktop/funnel/videogeneradorxd`
- **Archivos que este task puede tocar** (5, y ninguno más):

```
src/app/api/projects/[id]/generate/route.ts    (POST)
src/app/api/projects/[id]/upload/route.ts      (POST)
src/app/api/projects/[id]/references/route.ts  (GET, POST)
src/app/api/projects/[id]/stitch/route.ts      (POST)
src/app/api/projects/[id]/download/route.ts    (GET)
```

Leé `00-PLAN-AISLAMIENTO-USUARIO.md` completo. Tu contrato es **§4** (las firmas) y **§5.1** (el
patrón de call site).

**Ojo con T02: escribe los otros 6 archivos de `src/app/api/projects/[id]/`.** Antes de abrir un
archivo de ese directorio, fijate que esté en la lista de arriba. Los conjuntos son disjuntos.

**Tus 5 rutas son las que gastan plata y las que entregan los archivos.** `generate` larga la cola de
Veo y Nano Banana; `download` baja el zip con todo el material. Son las dos peores de olvidarse.

---

## 1. Objetivo

Cuando termines, tus 5 archivos rechazan con **404** cualquier `params.id` que no sea un proyecto del
usuario logueado. Son **6 handlers** (`references/route.ts` tiene 2).

**Este task no cambia ninguna lógica de negocio, no toca el manejo de `FormData`, y no modifica
`src/lib/`.**

---

## 2. El patrón

Primera línea del `try`, **antes de leer el body o el `FormData`** y antes de cualquier
`projectsDb.get()`:

```ts
const guard = requireProjectOwner(params.id);
if (!guard.ok) return guard.response;
```

**Antes de leer el body, y en tus rutas eso importa más que en las de T02:** `upload` y `references`
reciben archivos por `FormData`. Si el guard fuera después, el server **recibiría y bufferearía el
archivo completo** de alguien que no tiene permiso antes de rechazarlo. Con clips de video eso son
decenas de MB por request.

Lo que ya estaba se conserva, incluido el `projectsDb.get()` + `notFound()` si la ruta lo tiene (ver
§5.1 del plan: borrarlo cambia el tipo de `project` y obliga a tocar más líneas).

---

## 3. Los 5 archivos, y lo que hay que mirar en cada uno

| Archivo | Handlers | Lo que no es obvio |
|---|---|---|
| `[id]/generate/route.ts` | POST | **la que gasta.** Construye los jobs y arranca la cola. Sin guard, uno larga la generación del proyecto del otro y le quema la cuota facturable |
| `[id]/upload/route.ts` | POST | sube el `.mp4` de un clip `FILMAR_REAL`. `FormData`: el guard va antes de leerlo |
| `[id]/references/route.ts` | GET, POST | **dos guards.** El `GET` lista los avatares de referencia — que son **fotos de personas reales**, así que la fuga acá no es solo de trabajo. El `POST` sube: `FormData`, guard antes |
| `[id]/stitch/route.ts` | POST | corre ffmpeg sobre los clips del proyecto. Es CPU del server: sin guard es también una forma de hacerle esperar el export al otro |
| `[id]/download/route.ts` | GET | **la que entrega todo.** Baja el zip del proyecto entero (imágenes, clips, manifest, el video unido) o un archivo suelto. Es la fuga más directa de material ya pagado |

---

## 4. Verificación

Nada de esto es opcional. Un task que no corre su verificación no está terminado, y "compila" no es
verificación.

```bash
cd /Users/lucho/Desktop/funnel/videogeneradorxd

# 1 — tus 5 archivos importan el helper
grep -lE "from \"@/lib/ownership\"" \
  "src/app/api/projects/[id]/generate/route.ts" \
  "src/app/api/projects/[id]/upload/route.ts" \
  "src/app/api/projects/[id]/references/route.ts" \
  "src/app/api/projects/[id]/stitch/route.ts" \
  "src/app/api/projects/[id]/download/route.ts" | wc -l | tr -d ' '
# esperado exactamente: 5

# 2 — hay 6 guards en total (references/route.ts tiene 2: GET y POST)
grep -rc "requireProjectOwner(params.id)" \
  "src/app/api/projects/[id]/generate/route.ts" \
  "src/app/api/projects/[id]/upload/route.ts" \
  "src/app/api/projects/[id]/references/route.ts" \
  "src/app/api/projects/[id]/stitch/route.ts" \
  "src/app/api/projects/[id]/download/route.ts" | awk -F: '{s+=$2} END {print s}'
# esperado exactamente: 6
#   Si da 5, te olvidaste de uno de los dos handlers de references/route.ts.

# 3 — cada handler exportado tiene su guard
for f in "src/app/api/projects/[id]/generate/route.ts" "src/app/api/projects/[id]/upload/route.ts" \
         "src/app/api/projects/[id]/references/route.ts" "src/app/api/projects/[id]/stitch/route.ts" \
         "src/app/api/projects/[id]/download/route.ts"; do
  h=$(grep -cE "^export async function (GET|POST|PUT|DELETE)" "$f")
  g=$(grep -c "requireProjectOwner" "$f")
  printf "%-52s handlers=%s guards=%s\n" "${f#src/app/api/}" "$h" "$g"
done
# esperado exactamente: en las 5 lineas, handlers == guards
#   references/route.ts con 2 y 2; las otras 4 con 1 y 1

# 4 — el guard va ANTES de leer el body o el FormData
for f in "src/app/api/projects/[id]/upload/route.ts" "src/app/api/projects/[id]/references/route.ts"; do
  g=$(grep -n "requireProjectOwner" "$f" | head -1 | cut -d: -f1)
  b=$(grep -nE "(formData|req\.json)\(\)" "$f" | head -1 | cut -d: -f1)
  [ -n "$b" ] && [ "$g" -lt "$b" ] && echo "ok ${f#src/app/api/} (guard $g < body $b)" \
    || echo "REVISAR ${f#src/app/api/} (guard $g, body $b)"
done
# esperado exactamente: 2 lineas "ok ...", ninguna "REVISAR"

# 5 — typecheck
rm -rf .next && npx tsc --noEmit
# esperado: sin salida, exit 0

# 6 — tus 5 rutas ya estan en verde en la verificacion del modulo
bash tasks/aislamiento-por-usuario/_verificacion-aislamiento.sh 2>&1 \
  | grep -E "projects/\[id\]/(generate|upload|references|stitch|download)"
# esperado exactamente: 5 lineas, todas empezando con "OK"

# 7 — no rompiste ningun endpoint
bash tasks/_verificacion-endpoints.sh | tail -1
# esperado exactamente: SIN REGRESIONES
```

---

## 5. Cuándo parar

**Bloqueante, pará y avisá:**

- `requireProjectOwner` no existe o no tiene la firma de §4 → T01 no terminó. **No improvises un
  chequeo propio.**
- `download/route.ts` sirve el archivo de una forma que el guard rompe (por ejemplo, un stream que ya
  arrancó). Pará y avisá: es la ruta que entrega todo el material y no puede quedar a medias.

**Anotalo en §10 del plan y seguí:**

- `references/route.ts` en `GET` devuelve fotos de personas y te parece que además hace falta algo más
  (expiración, marca de agua). Anotalo: es otro módulo.
- Encontrás que `stitch` o `generate` pueden dejar trabajo a medias si el guard corta en el medio.
  Anotalo con el path.
- Necesitás modificar un archivo ajeno → **nunca**; anotalo.
