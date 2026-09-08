# Prompts para Claude Code — aislamiento por usuario

## Antes de arrancar

```
tasks/aislamiento-por-usuario/
├── 00-PLAN-AISLAMIENTO-USUARIO.md      el documento maestro. Todos lo leen completo
├── PROMPT-CLAUDE-CODE.md               este archivo
├── _migracion-owner.mjs                el script de migracion CANONICO, ya ejecutado
├── _verificacion-migracion.mjs         sus 7 afirmaciones, ya en verde
├── _verificacion-aislamiento.sh        la verificacion de aceptacion del modulo
├── T01-fundacion.md                    el contrato. VA SOLA
├── T02-rutas-proyecto-control.md       6 rutas
├── T03-rutas-proyecto-acciones.md      5 rutas
├── T04-rutas-jobs.md                   6 rutas
├── T05-listado-y-creacion.md           2 rutas — es la que cumple el pedido original
├── T06-archivos-y-lote.md              2 rutas — el agujero mas grande
├── T07-ui.md                           3 archivos de pantalla
└── T08-produccion.md                   migracion + deploy + QA. VA SOLA Y ULTIMA
```

Dos de esos archivos **no son documentación, son código que ya corrió**:

```bash
node tasks/aislamiento-por-usuario/_verificacion-migracion.mjs
# TODO EN VERDE (7/7)

bash tasks/aislamiento-por-usuario/_verificacion-aislamiento.sh
#  verde: 7   pendiente: 24   FALLO: 0
```

Eso ahorra trabajo real: **la migración ya está escrita y probada** contra una base scratch con 12
proyectos, con las 7 garantías del §3 del plan (idempotencia, backup, no pierde campos opcionales,
aborta si falta un nombre de Ivan). Nadie tiene que diseñarla ni testearla: T01 la copia.

### 6 cosas que hay que saber antes de largar el primer agente

**1. T01 va sola y primero.** Declara `src/lib/ownership.ts`, que las seis tasks de la ola 2 importan.
Sin ese archivo, las seis fallan el `tsc` en la primera línea. No es una preferencia de orden.

**2. Si T01 se desvía del contrato de §4, se para el proyecto.** Las seis siguientes se escriben contra
esas 5 firmas al mismo tiempo. Un `requireProjectOwner` que devuelve otra cosa obliga a rehacer las
seis. Si algo de §4 no se puede implementar, el agente **para y avisa**; no lo arregla por su cuenta.

**3. Esto es una app en producción con ~12 proyectos reales adentro**, en
`generador.hilvanapp.online`, PM2 con **una sola instancia** (la cola de jobs vive en memoria del
proceso). Los proyectos tienen imágenes y videos de Veo ya pagados. El usuario dijo textual: *"no los
quiero perder"*. Ninguna task de la ola 1 o 2 toca producción: **solo T08**.

**4. El riesgo del módulo es al revés de lo habitual.** Acá no se puede gastar plata de más ni borrar
nada: el peligro es **dejar afuera al dueño legítimo**. Un filtro de más y Lucho pierde de vista sus 8
proyectos. De ahí salen las tres defensas: `owner` es opcional en el tipo (cambio aditivo), la
migración hace backup y es idempotente, y el criterio 9 del QA de T08 es específicamente *"Lucho sigue
viendo todo lo suyo"*.

**5. La ola 2 son 6 agentes en paralelo y los conjuntos de archivos son disjuntos.** La trampa está en
que **T02 y T03 escriben archivos distintos del mismo directorio** (`src/app/api/projects/[id]/`).
Antes de abrir un archivo de ahí, mirá la fila de §7. Es la única colisión posible del módulo.

**6. El plan es el contrato.** §4 (las firmas) y §5 (los patrones de call site) están **congelados**.
Nadie los modifica, ni para mejorarlos. Lo que el plan no resuelve va a §10, no al código.

## El orden

```
Paso 1   T01                                        1 agente, SOLO
Paso 2   T02 · T03 · T04 · T05 · T06 · T07          6 en paralelo
Paso 3   T08                                        1 agente, solo y ultimo
```

**Una task bloqueante no está terminada hasta que su verificación pasa.** La ola 2 no arranca hasta
que T01 dé `verde: 10   pendiente: 21   FALLO: 0`. La ola 3 no arranca hasta que
`_verificacion-aislamiento.sh` diga **AISLAMIENTO COMPLETO**.

Las seis de la ola 2 pueden correr juntas porque consumen el **contrato** de §4, no la implementación
de la otra: cada una importa las mismas funciones y toca sus propios archivos. T07 (UI) no importa
`ownership.ts` en absoluto — es código de cliente — así que también entra.

**Si preferís ir de a uno:** T01 → T05 → T02 → T03 → T04 → T06 → T07 → T08. T05 temprano porque es la
que hace que los proyectos nuevos nazcan con dueño, que es el pedido literal del usuario. **T08 siempre
al final**: es la única que escribe en producción.

---

## Preámbulo (va al inicio de cada prompt)

> Estás trabajando en `/Users/lucho/Desktop/funnel/videogeneradorxd`, una app Next.js 14 (App Router,
> TypeScript) que genera anuncios UGC, VSLs e imágenes con Vertex AI. **Está en producción** en
> `generador.hilvanapp.online` con login por usuario y ~12 proyectos reales adentro, con imágenes y
> videos ya pagados.
>
> Leé estos archivos completos antes de escribir código, en este orden:
> 1. `tasks/aislamiento-por-usuario/00-PLAN-AISLAMIENTO-USUARIO.md`
> 2. `tasks/aislamiento-por-usuario/<TU-TASK>.md`
>
> Contexto que te ahorra tiempo: **el login ya existe y funciona** — cookie `gen_session` firmada con
> HMAC, `currentUser(cookies())` en `src/lib/auth.ts`, un usuario por variable `PASSWORD_<NOMBRE>`. No
> hay que construir nada de eso. Lo que falta es **autorización**: `ProjectRecord` no tiene dueño y
> ninguna de las 25 route handlers compara la sesión contra el proyecto.
>
> Reglas que no se negocian:
> - **Solo escribís los archivos de tu fila en §7 del plan.** Hay otros 5 agentes trabajando en
>   paralelo. Si creés que necesitás tocar uno ajeno, va a §10.
> - **Hay una lista de archivos que NADIE toca** (§7, al final). Son caminos que hoy funcionan en
>   producción: `auth.ts`, `middleware.ts`, `db.ts`, `batch.ts`, `queue.ts`, `pipeline.ts`, y las
>   pantallas que no necesitan cambios.
> - **No instalás dependencias ni editás `package.json`.** Este módulo no agrega ninguna.
> - **No cambiás los contratos.** §4 (las 5 firmas) y §5 (los patrones de call site) están congelados
>   porque 6 tasks se escriben contra ellos al mismo tiempo.
> - **Si aparece una decisión que el plan no resuelve, no la decidís en el código:** va a §10 del plan.
>   Si bloquea, parás y avisás.
> - **Idioma:** todo en español rioplatense (voseo), incluidos los comentarios. Los comentarios de este
>   repo explican *por qué*, y cuando documentan una decisión traen **el bug que evita**. Los
>   comentarios largos que ya están son deliberados: no los "limpies".
> - **Al terminar, corré tu sección de Verificación COMPLETA y pegame la salida.** Si algo falla,
>   arreglalo antes de decir que terminaste. "Compila" no es verificación.

---

## Paso 1

### T01 — Fundación: el campo, el helper y el script

> [preámbulo, con `<TU-TASK>` = `T01-fundacion.md`]
>
> Ejecutá T01 completa: `owner?: string` en `ProjectRecord`, `src/lib/ownership.ts` con las 5 funciones
> de §4, y copiar el script de migración canónico a `scripts/migrar-owner.mjs`.
>
> Cuatro cosas con atención especial:
>
> **1. Las 5 firmas de §4 son contrato literal.** Hay 6 tasks que arrancan en cuanto termines y que se
> escriben contra ellas. Si alguna no se puede implementar como está, **pará y avisá** — no la
> adaptes. Cambiarla obliga a rehacer las seis.
>
> **2. `owner` va OPCIONAL (`owner?: string`).** Si lo ponés obligatorio, `tsc` rompe en todos los
> lugares que construyen un `ProjectRecord` y tendrías que arreglarlos acá, que es exactamente la
> colisión que el plan evita. Y `undefined` **no** significa "de todos": el filtro es
> `p.owner === usuario`, así que un proyecto sin dueño queda invisible hasta que corra la migración.
> Eso es deliberado (D2).
>
> **3. `requireJobOwner` resuelve el proyecto con `jobsDb.get(jobId).projectId`, NUNCA parseando el
> string.** El formato es `<projectId>:img:<imageId>` y el `imageId` sale del PlanJSON, que lo escribe
> el usuario: puede contener `:`. Un `split(":")[0]` parece andar con los datos de hoy y se rompe con
> un plan raro. Es la regla 4 de §4.
>
> **4. `scripts/migrar-owner.mjs` es un `cp`, no una reescritura.** El archivo
> `tasks/aislamiento-por-usuario/_migracion-owner.mjs` ya se ejecutó contra una base scratch y tiene 7
> afirmaciones verificadas. Si lo tipeás de nuevo, las perdés. Y **no le cambies los 4 nombres de
> Ivan**.
>
> Tu verificación tiene 11 pasos. El paso 10 es la compuerta: tiene que dar exactamente
> `verde: 10   pendiente: 21   FALLO: 0`.

---

## Paso 2 — los 6 en paralelo

### T02 — Las 6 rutas de lectura y control de proyecto

> [preámbulo, con `<TU-TASK>` = `T02-rutas-proyecto-control.md`]
>
> Agregá el guard de dueño a tus 6 archivos de `src/app/api/projects/[id]/`. Son **8 handlers**: el
> primer archivo (`[id]/route.ts`) tiene GET, PUT y DELETE.
>
> Tres cosas con atención especial:
>
> **1. T03 está trabajando en el MISMO directorio, en los otros 5 archivos.** Antes de abrir cualquier
> cosa de `src/app/api/projects/[id]/`, mirá tu lista. Es la única colisión posible del módulo.
>
> **2. El guard va antes de leer el body.** Si va después, un POST ajeno con body inválido devuelve
> 400 en vez de 404 — y ese 400 confirma que el proyecto existe, que es justo lo que D4 no permite
> filtrar.
>
> **3. No borres el `projectsDb.get()` + `notFound()` que ya está.** El guard lo vuelve redundante,
> pero sacarlo cambia el tipo de `project` a `ProjectRecord | undefined` en el resto de la función y te
> obliga a tocar líneas de más. Cada línea de más es una chance de romper algo que funciona.
>
> El paso 2 de tu verificación tiene que dar exactamente **8**. Si da 6, te olvidaste del PUT y del
> DELETE.

### T03 — Las 5 rutas de acciones y archivos de proyecto

> [preámbulo, con `<TU-TASK>` = `T03-rutas-proyecto-acciones.md`]
>
> Agregá el guard de dueño a tus 5 archivos de `src/app/api/projects/[id]/`. Son **6 handlers**:
> `references/route.ts` tiene GET y POST.
>
> Tres cosas con atención especial:
>
> **1. T02 está trabajando en el MISMO directorio, en los otros 6 archivos.** Mirá tu lista antes de
> abrir un archivo de ahí.
>
> **2. Tus rutas son las que gastan plata y las que entregan el material.** `generate` larga la cola de
> Veo y Nano Banana; `download` baja el zip con todo. Son las dos peores de olvidarse.
>
> **3. En `upload` y `references` el guard va antes de leer el `FormData`.** Si va después, el server
> recibe y bufferea el archivo completo de alguien sin permiso antes de rechazarlo — con clips de video
> son decenas de MB por request.
>
> El paso 2 de tu verificación tiene que dar exactamente **6**. Si da 5, te olvidaste de uno de los dos
> handlers de `references/route.ts`.

### T04 — Las 6 rutas de job

> [preámbulo, con `<TU-TASK>` = `T04-rutas-jobs.md`]
>
> Agregá el guard a tus 6 archivos de `src/app/api/jobs/[id]/`. En tu caso el guard **reemplaza** el
> `jobsDb.get(params.id)` que ya está, no se agrega al lado: `requireJobOwner` devuelve el job ya
> resuelto en `guard.job`.
>
> Tres cosas con atención especial:
>
> **1. Entendé por qué tu task es la que más importa.** Los ids de job son **derivados y predecibles**:
> `<projectId>:img:<imageId>` y `<projectId>:vid:<clipId>` (`src/lib/jobs/pipeline.ts:43-48`). Con un
> solo projectId se construyen todos los ids de job del proyecto. Y tus rutas no son de lectura:
> aprueban, regeneran, editan el guion y extienden videos. Sin guard, un projectId ajeno alcanza para
> **modificar y gastar** en el proyecto del otro.
>
> **2. Usá `guard.job`, no hagas un `jobsDb.get()` al lado.** Sería una segunda consulta a la DB por
> request y dos fuentes para el mismo dato.
>
> **3. Si un archivo queda sin usar `jobsDb`, sacá el import. Pero fijate archivo por archivo:**
> `preview/route.ts` sigue usando `projectsDb` y `jobsDb.imageJob()`, así que ahí el import se queda.
>
> El paso 2 de tu verificación tiene que decir `el lookup viejo ya no esta`.

### T05 — Listado y creación

> [preámbulo, con `<TU-TASK>` = `T05-listado-y-creacion.md`]
>
> Dos archivos: `src/app/api/projects/route.ts` y `src/app/api/imagenes/route.ts`. El `GET` filtra por
> dueño; los dos `POST` graban el dueño desde la sesión.
>
> **Tu task es la que cumple el pedido literal del usuario** ("que los proyectos nuevos estén por
> usuario"), y `GET /api/projects` es la lista que hoy muestra los proyectos del otro en la home, en
> `/imagenes` y en el selector de `/batch`.
>
> Cuatro cosas con atención especial:
>
> **1. El `owner` sale SOLO de la cookie. Nunca del body.** Ni `body.owner`, ni
> `body.owner ?? user`, ni ninguna variante. Si el body lo trae, se ignora en silencio. Un `owner` que
> viene del cliente permite que Ivan cree proyectos a nombre de Lucho (D3).
>
> **2. El filtro va en la ruta, no en `db.ts`.** `projectsDb.list()` sigue devolviendo todo: `db.ts`
> está en la lista de intocables y la capa de datos no tiene que saber que existen usuarios.
>
> **3. El filtro es `p.owner === user`, y un proyecto sin dueño NO matchea.** No agregues un caso
> "sin dueño se ve igual": sería el agujero que este módulo cierra (D2). Los proyectos viejos los
> arregla la migración de T08.
>
> **4. El chequeo de sesión va antes de `ensureProjectDirs`.** Si va después, un request sin sesión
> deja carpetas huérfanas en `OUTPUT_DIR` que nadie va a limpiar, porque no hay ningún registro que las
> referencie.
>
> Leé `src/app/api/imagenes/route.ts` completo: construye su propio `ProjectRecord` y ahí también va el
> campo.

### T06 — Archivos y lote

> [preámbulo, con `<TU-TASK>` = `T06-archivos-y-lote.md`]
>
> Dos archivos, y **usan helpers y estrategias distintas**: `files/[...path]/route.ts` **rechaza** con
> `requireProjectOwner`, `batch/route.ts` **filtra** con `filterOwnedIds`. No las unifiques.
>
> Cuatro cosas con atención especial:
>
> **1. `/api/files/` es el agujero más grande del módulo: hoy ni consulta la DB.** Solo valida path
> traversal con `safeResolve`, que impide salir de la carpeta pero no tiene ninguna opinión sobre de
> quién es. Con un projectId se ven y se bajan todas las imágenes, todos los clips y el manifest
> completo del proyecto ajeno.
>
> **2. `safeResolve` NO se saca.** El guard es autorización, `safeResolve` es anti-traversal: son dos
> defensas distintas. Un dueño legítimo con un path malicioso sigue necesitando la segunda.
>
> **3. En `batch`, los ids rechazados van a `missingIds`, que ya existe** en `BatchSnapshot` y que
> `BatchBoard.tsx:596` ya renderiza. No inventes un campo nuevo: agregar `foreignIds` te obligaría a
> tocar `batch.ts` (intocable) y `BatchBoard.tsx` (que es de T07). Ajenos e inexistentes van mezclados
> a propósito: separarlos permite distinguir "no existe" de "no es tuyo" (D4).
>
> **4. En el `POST` de batch, el loop de acciones itera sobre `owned`, no sobre los ids del body.** Si
> itera sobre el body, la acción se ejecuta sobre proyectos ajenos aunque la respuesta después los
> filtre: el daño ya está hecho.
>
> `src/lib/batch.ts` no se toca. El paso 8 de tu verificación lo comprueba.

### T07 — UI

> [preámbulo, con `<TU-TASK>` = `T07-ui.md`]
>
> Tres archivos de pantalla. Sos la única task de la ola que no toca el backend y no importa
> `ownership.ts` (es código de servidor; tus archivos son `"use client"`).
>
> Tres cosas con atención especial:
>
> **1. El cartel de `BatchBoard.tsx:596-604` hoy dice "Estos proyectos ya no existen (los borraste)".**
> Después de T06 esa lista trae ids borrados **y** ids de otro usuario mezclados, así que el texto pasa
> a ser falso. Y **no se arregla diciendo la verdad**: si dijera "no son tuyos" confirmaría que el
> proyecto existe, que es lo que D4 no permite. El texto nuevo tiene que ser neutro y no dejar
> distinguir los dos casos.
>
> **2. Conservá el botón "quitarlos del tablero" con su `onClick` exacto.** Es la única forma de
> limpiar la URL del lote. El paso 3 de tu verificación lo cuenta.
>
> **3. `src/app/page.tsx` y `ImagenesBoard.tsx` NO se tocan y están en la lista de intocables.** Ya
> filtran client-side y **ya tienen `EmptyState`** (verificado: `page.tsx:1046`,
> `ImagenesBoard.tsx:880`), así que un usuario con cero proyectos ya ve un estado vacío decente. No hay
> nada que arreglar ahí. Tampoco tocás `useProjectStore.ts`: el manejo del error va en la página, con
> `try/catch`.
>
> El paso 9 de tu verificación (`_verificacion-endpoints.sh` en `SIN REGRESIONES`) es el que importa en
> una task de UI: es lo que atrapa un `fetch` perdido reescribiendo JSX.

---

## Paso 3

### T08 — Producción: migrar, deployar y probar con las dos cuentas

> [preámbulo, con `<TU-TASK>` = `T08-produccion.md`]
>
> Ejecutá el runbook de §9 del plan. **Esta task escribe en el `db.json` de producción**, donde hay ~12
> proyectos con imágenes y videos ya pagados.
>
> Cinco cosas con atención especial:
>
> **1. La compuerta primero.** `bash tasks/aislamiento-por-usuario/_verificacion-aislamiento.sh` tiene
> que decir `AISLAMIENTO COMPLETO`. Si no, pará y decí qué task falta. **No arregles código de otra
> task**: el dueño de ese archivo pierde el control de su diff.
>
> **2. `--dry-run` primero, y leelo de verdad.** Ahí se decide todo. Los 4 nombres de los proyectos de
> Ivan **nunca se pudieron verificar contra la DB real** (P-01): se transcribieron de un mensaje y en
> este checkout no existe `./data`. Si el script aborta porque falta uno, **compará carácter por
> carácter** con la lista que imprime y avisale al usuario los dos nombres. **No uses
> `--permitir-faltantes` para salir del paso.**
>
> **3. La migración va ANTES del deploy** (D11). El código que está corriendo ignora `owner`, así que
> migrar primero no cambia nada para nadie. Al revés habría una ventana con los 12 proyectos
> invisibles para todos.
>
> **4. Pará antes del deploy y pedí confirmación.** `deploy.sh` corre en el server como usuario
> `deploy` y hace `git reset --hard origin/main`: **lo que no esté pusheado a `main` no se deploya, y
> el script no avisa** — construye la release con el commit viejo y el health check pasa igual.
> Mostrale el comando y esperá.
>
> **5. El criterio 9 del QA es el que importa: "Lucho sigue viendo todo lo suyo".** El objetivo era
> aislar, no perder. Si a Lucho le falta un proyecto, restaurá el backup y avisá.

---

## Qué revisar cuando terminan

```bash
cd /Users/lucho/Desktop/funnel/videogeneradorxd

# 1 — compila
rm -rf .next && npx tsc --noEmit && npm run build 2>&1 | tail -3
# esperado: tsc sin salida (exit 0), y el build con "Compiled successfully"

# 2 — LA VERIFICACION BLOQUEANTE DEL MODULO
bash tasks/aislamiento-por-usuario/_verificacion-aislamiento.sh | tail -5
# esperado exactamente: AISLAMIENTO COMPLETO
#   (verde: 31   pendiente: 0   FALLO: 0)

# 3 — las afirmaciones de la migracion siguen en verde
node tasks/aislamiento-por-usuario/_verificacion-migracion.mjs | tail -1
# esperado exactamente: TODO EN VERDE (7/7)

# 4 — NADA DE LO QUE YA FUNCIONABA CAMBIO: ninguna pantalla perdio un fetch
bash tasks/_verificacion-endpoints.sh | tail -1
# esperado exactamente: SIN REGRESIONES

# 5 — los archivos que nadie toca siguen sin tocar
git diff --name-only src/lib/auth.ts src/middleware.ts src/lib/db.ts src/lib/batch.ts \
  src/lib/jobs/queue.ts src/lib/jobs/pipeline.ts src/lib/config.ts src/lib/storage.ts \
  src/lib/http.ts src/app/page.tsx src/app/imagenes/ImagenesBoard.tsx \
  src/store/useProjectStore.ts | grep . && echo "ERROR: se toco un intocable" || echo "intocables intactos"
# esperado exactamente: intocables intactos

# 6 — el owner nunca se acepta del body, en ninguna ruta
grep -rn --include='route.ts' -E "(body[?]?\.owner|body\[.owner.\])" src/app/api/ \
  || echo "el owner no viene del body en ninguna ruta"
# esperado exactamente: el owner no viene del body en ninguna ruta

# 7 — las 4 rutas sin dueño que chequear siguen sin guard
grep -l "ownership" src/app/api/login/route.ts src/app/api/config/route.ts \
  src/app/api/parse/route.ts src/app/api/prompt-template/route.ts 2>/dev/null \
  && echo "ERROR: una ruta publica tiene el guard" || echo "login/config/parse/template sin guard"
# esperado exactamente: login/config/parse/template sin guard

# 8 — el circuito completo, a mano, con las DOS passwords
#     Es el criterio 6 de §8 del plan: 9 puntos, cada uno con su resultado esperado.
#     No se puede verificar con curl solo: hay que entrar con las dos cuentas.

# 9 — leé las preguntas abiertas que quedaron
sed -n '/## 10. Preguntas abiertas/,$p' tasks/aislamiento-por-usuario/00-PLAN-AISLAMIENTO-USUARIO.md
```

**Si el paso 2 no dice `AISLAMIENTO COMPLETO`, T08 no arranca** — y sin T08 los 12 proyectos que ya
existen quedan sin dueño, o sea invisibles para todos. El módulo no se puede dejar a medias: o están
las 21 rutas y la migración, o el estado es peor que el de hoy.
