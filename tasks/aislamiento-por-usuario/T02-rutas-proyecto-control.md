# T02 — `/api/projects/[id]`: las 6 rutas de lectura y control

- **Depende de:** T01 (importás `requireProjectOwner` de `src/lib/ownership.ts`)
- **Bloquea:** T08 (no puede migrar ni deployar hasta que estén todas las rutas)
- **Se puede correr en paralelo con:** T03, T04, T05, T06, T07
- **Repo:** `/Users/lucho/Desktop/funnel/videogeneradorxd`
- **Archivos que este task puede tocar** (6, y ninguno más):

```
src/app/api/projects/[id]/route.ts                  (GET, PUT, DELETE)
src/app/api/projects/[id]/jobs/route.ts             (GET)
src/app/api/projects/[id]/control/route.ts          (POST)
src/app/api/projects/[id]/stage/route.ts            (POST)
src/app/api/projects/[id]/approve-batch/route.ts    (POST)
src/app/api/projects/[id]/regenerate-batch/route.ts (POST)
```

Leé `00-PLAN-AISLAMIENTO-USUARIO.md` completo. Tu contrato es **§4** (las firmas) y **§5.1** (el
patrón de call site, que es el mismo para tus 6 archivos).

**Ojo con T03: escribe los otros 5 archivos de `src/app/api/projects/[id]/`.** Antes de abrir un
archivo de ese directorio, fijate que esté en la lista de arriba. Los conjuntos son disjuntos.

---

## 1. Objetivo

Cuando termines, tus 6 archivos rechazan con **404** cualquier `params.id` que no sea un proyecto del
usuario logueado, y **8 handlers** (el primer archivo tiene 3) quedan con el guard.

**Este task no cambia ninguna lógica de negocio, no toca el body de ninguna respuesta exitosa, y no
modifica `src/lib/`.** Es el mismo bloque de 2 líneas, 6 veces.

---

## 2. El patrón, y por qué va donde va

Primera línea del `try`, **antes de leer el body** y antes de cualquier `projectsDb.get()`:

```ts
const guard = requireProjectOwner(params.id);
if (!guard.ok) return guard.response;
```

**Va antes de leer el body a propósito.** Si fuera después, un `POST` ajeno con body inválido
devolvería 400 en vez de 404, y ese 400 confirma que el proyecto existe (rompe D4, que es la decisión
de no filtrar existencia).

**Lo que ya estaba se conserva.** Si la ruta hace `const project = projectsDb.get(params.id); if
(!project) return notFound(...)`, dejalo. El guard ya garantiza que existe, pero borrarlo cambia el
tipo de `project` a `ProjectRecord | undefined` en el resto de la función y te obliga a tocar más
líneas de las necesarias — y cada línea de más es una chance de romper algo que funciona.

En `route.ts`, que tiene **3 handlers** (`GET`, `PUT`, `DELETE`), el guard va en **los tres**. El
`DELETE` borra la carpeta del proyecto en disco (`removeProjectDir`): es el handler más caro de
olvidarse.

---

## 3. Los 6 archivos, y lo que hay que mirar en cada uno

| Archivo | Handlers | Lo que no es obvio |
|---|---|---|
| `[id]/route.ts` | GET, PUT, DELETE | tres guards, uno por handler. El `PUT` recibe plan/nombre/modelos en el body: el guard va **antes** de parsearlo. **Y nunca leas `owner` del body** (D3): si viene, se ignora |
| `[id]/jobs/route.ts` | GET | es el endpoint de **polling**: lo llaman cada pocos segundos. No agregues nada más que el guard, y no agregues logs |
| `[id]/control/route.ts` | POST | `pause`/`resume`/`cancel`. Actúa sobre la cola compartida: sin guard, uno puede cancelar la generación del otro a mitad de camino y con el gasto ya hecho |
| `[id]/stage/route.ts` | POST | cambia la fase `images`→`videos`. Sin guard, uno puede largar los videos del otro, que es la parte que cuesta USD |
| `[id]/approve-batch/route.ts` | POST | aprueba el lote y desbloquea lo que depende |
| `[id]/regenerate-batch/route.ts` | POST | recibe `{jobIds}`/`{refIds}` en el body. **El guard sobre `params.id` alcanza**: `pipeline` ya resuelve esos jobs dentro del proyecto. No agregues un chequeo por job — eso es T04 y es para `/api/jobs/*` |

---

## 4. Verificación

Nada de esto es opcional. Un task que no corre su verificación no está terminado, y "compila" no es
verificación.

```bash
cd /Users/lucho/Desktop/funnel/videogeneradorxd

# 1 — tus 6 archivos importan el helper
grep -lE "from \"@/lib/ownership\"" \
  "src/app/api/projects/[id]/route.ts" \
  "src/app/api/projects/[id]/jobs/route.ts" \
  "src/app/api/projects/[id]/control/route.ts" \
  "src/app/api/projects/[id]/stage/route.ts" \
  "src/app/api/projects/[id]/approve-batch/route.ts" \
  "src/app/api/projects/[id]/regenerate-batch/route.ts" | wc -l | tr -d ' '
# esperado exactamente: 6

# 2 — hay 8 guards en total (route.ts tiene 3: GET, PUT, DELETE)
grep -rc "requireProjectOwner(params.id)" \
  "src/app/api/projects/[id]/route.ts" \
  "src/app/api/projects/[id]/jobs/route.ts" \
  "src/app/api/projects/[id]/control/route.ts" \
  "src/app/api/projects/[id]/stage/route.ts" \
  "src/app/api/projects/[id]/approve-batch/route.ts" \
  "src/app/api/projects/[id]/regenerate-batch/route.ts" | awk -F: '{s+=$2} END {print s}'
# esperado exactamente: 8
#   Si da 6, te olvidaste del PUT y del DELETE de route.ts.

# 3 — cada handler exportado de tus archivos tiene su guard
for f in "src/app/api/projects/[id]/route.ts" "src/app/api/projects/[id]/jobs/route.ts" \
         "src/app/api/projects/[id]/control/route.ts" "src/app/api/projects/[id]/stage/route.ts" \
         "src/app/api/projects/[id]/approve-batch/route.ts" \
         "src/app/api/projects/[id]/regenerate-batch/route.ts"; do
  h=$(grep -cE "^export async function (GET|POST|PUT|DELETE)" "$f")
  g=$(grep -c "requireProjectOwner" "$f")
  printf "%-58s handlers=%s guards=%s\n" "${f#src/app/api/}" "$h" "$g"
done
# esperado exactamente: en las 6 lineas, handlers == guards
#   projects/[id]/route.ts  handlers=3 guards=3, y las otras 5 con 1 y 1

# 4 — ninguna de tus rutas lee owner del body (D3)
grep -nE "(body[?]?\.owner|body\[.owner.\])" "src/app/api/projects/[id]"/*.ts \
  "src/app/api/projects/[id]"/*/*.ts || echo "no se lee owner del body"
# esperado exactamente: no se lee owner del body

# 5 — no tocaste archivos ajenos
git status --short src/ | grep -v -E "projects/\[id\]/(route|jobs/route|control/route|stage/route|approve-batch/route|regenerate-batch/route)\.ts" || echo "solo mis 6 archivos"
# esperado exactamente: solo mis 6 archivos
#   (si otro agente de la ola 2 ya commiteo, puede aparecer lo suyo: verificalo a ojo)

# 6 — typecheck
rm -rf .next && npx tsc --noEmit
# esperado: sin salida, exit 0

# 7 — tus 6 rutas ya estan en verde en la verificacion del modulo
bash tasks/aislamiento-por-usuario/_verificacion-aislamiento.sh 2>&1 \
  | grep -E "projects/\[id\]/(route|jobs|control|stage|approve-batch|regenerate-batch)"
# esperado exactamente: 6 lineas, todas empezando con "OK"

# 8 — no rompiste ningun endpoint
bash tasks/_verificacion-endpoints.sh | tail -1
# esperado exactamente: SIN REGRESIONES
```

---

## 5. Cuándo parar

**Bloqueante, pará y avisá:**

- `requireProjectOwner` no existe o no tiene la firma de §4. Significa que T01 no terminó: **no
  improvises un chequeo propio**, porque las otras 5 tasks van a usar el helper y quedarían dos formas
  distintas de autorizar.
- Una de tus 6 rutas **no recibe `params.id`** de la forma que dice el plan. Pará y avisá: el
  inventario está mal y puede haber más rutas en esa situación.

**Anotalo en §10 del plan y seguí:**

- Una ruta hace algo que el guard vuelve inalcanzable (por ejemplo, un caso especial para proyectos
  borrados). Anotalo con el path y la línea.
- Te parece que `regenerate-batch` debería validar además que los `jobIds` del body sean del proyecto.
  **Anotalo, no lo agregues:** hoy `pipeline` ya los resuelve dentro del proyecto, y agregarlo acá
  duplicaría la lógica de T04.
- Necesitás modificar un archivo ajeno → **nunca**; anotalo.
