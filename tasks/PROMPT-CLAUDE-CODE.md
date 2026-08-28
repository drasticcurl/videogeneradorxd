# Prompts para Claude Code — rediseño de UI

## Antes de arrancar

```
tasks/
├── 00-PLAN-REDISENO-UI.md          el documento maestro. Todo agente lo lee COMPLETO.
├── PROMPT-CLAUDE-CODE.md           este archivo
├── _verificacion-inventario.sh     los archivos que el plan cita existen        (en verde)
├── _verificacion-contraste.mjs     contraste WCAG de la paleta, 0 fallos        (en verde)
├── _verificacion-endpoints.sh      NINGUNA pantalla perdio un fetch             (en verde)
├── T01-fundacion.md                deps, tokens, tipografia, 10 primitivas
├── T02-componentes-compartidos.md  los 8 componentes de src/components/
├── T03-jobcard.md                  la tarjeta de job (544 lineas, 4 pantallas la usan)
├── T04-login.md                    login
├── T05-home.md                     home
├── T06-imagenes.md                 imagenes
├── T07-batch.md                    tablero de lotes
├── T08-result.md                   resultado del proyecto
├── T09-review.md                   deck de revision           (riesgo alto)
├── T10-videos.md                   deck de videos             (riesgo alto)
├── T11-pipeline.md                 pipeline, 1187 lineas      (riesgo MAXIMO)
└── T12-limpieza-y-qa.md            borrar alias + QA final
```

**Los tres `_verificacion-*` no son documentación: son comandos que corren y ya están en verde.**
Se corrieron antes de escribir una línea de plan, y uno de ellos corrigió el propio plan (el conteo
de archivos decía 23 y son 24).

Lo que ya está verificado, para que nadie lo vuelva a averiguar:

| Afirmación | Cómo se probó |
|---|---|
| El CLI de shadcn **rompe esta app** | Se corrió contra una copia. `shadcn@4.19.0` se cuelga esperando input con `-y`. `shadcn@2.1.8` corre pero convierte `accent` en `hsl(var(--accent))` con la variable en `oklch()`: CSS inválido, y los 25 usos de `bg-accent` quedan sin fondo. |
| La paleta nueva pasa WCAG AA | `_verificacion-contraste.mjs`, 15 pares, 0 fallos. |
| El acento actual **no** pasa AA | El mismo archivo: indigo-500 da 4.45:1 y 4.28:1, contra 4.5 de mínimo. |
| `zinc-500` no sirve como texto | 4.12:1. El piso es `zinc-400`. |
| Hacen falta **dos** tokens de borde | `zinc-600/700/800` no llegan al 3:1 que pide WCAG 1.4.11 para controles. |
| `tailwind-merge` va en 2.6.1 | La 3.x es para Tailwind v4; este proyecto tiene 3.4.19. |
| Los 24 archivos y los 31 `fetch` existen | `_verificacion-inventario.sh` y `_verificacion-endpoints.sh`. |

### 5 cosas que hay que saber antes de largar el primer agente

**1. T01 va sola y primero.** Declara los tokens, las primitivas y el mapeo de estados que las otras
11 tasks importan. Nadie arranca hasta que su verificación pase.

**2. Si T01 falla, se para el proyecto.** No es una task más: si `geist` no compila con Next 14.2.35,
o si una primitiva no se puede implementar con la firma de §5, todo lo demás está escrito contra algo
que no existe.

**3. La app está EN PRODUCCIÓN** en https://generador.hilvanapp.online, con login para dos usuarios, y
genera contra Vertex AI, que **cobra por uso**. Un video de 8 segundos son varios dólares. Se usa
mientras esto se hace: por eso T01 deja los tokens viejos como alias, así ninguna pantalla sin migrar
queda sin estilos.

**4. El riesgo real de este módulo no es que quede feo: es que un botón deje de funcionar.** Un
`fetch` perdido al reescribir 800 líneas de JSX **no rompe el build ni el typecheck**. Rompe cuando
alguien aprieta "Aprobar" y no pasa nada. Las defensas: `_verificacion-endpoints.sh` compara contra
una línea base congelada, cada task cuenta sus `fetch` a mano, y **cada task tiene un QA a mano donde
hay que apretar cada botón**. Ninguna task está terminada sin eso.

**5. El plan es el contrato.** §4 (tokens), §5 (primitivas) y §6 (estados) están **congelados**: hay
11 tasks escribiéndose contra ellos en paralelo. Cambiar una firma rompe trabajo de otra ola. Y §8
(ownership) dice exactamente qué archivos puede tocar cada uno.

## El orden

```
Paso 1   T01                       1 agente, SOLO
Paso 2   T02 · T03                 2 en paralelo
Paso 3   T04 · T05 · T06           3 en paralelo
Paso 4   T07 · T08                 2 en paralelo
Paso 5   T09 · T10 · T11           3 en paralelo   (las de mayor riesgo)
Paso 6   T12                       1 agente, SOLO
```

**Una task bloqueante no está terminada hasta que su verificación pasa.** El paso siguiente no arranca
antes.

Por qué el orden es este y no otro:

- **T04, T05 y T06 podrían correr en el paso 2** (el ownership ya las aísla). Van después a propósito:
  son las pantallas más chicas, y si la ergonomía de las primitivas tiene un problema, es más barato
  descubrirlo en un login de 156 líneas que en el pipeline de 1187. **T04 tiene instrucción explícita
  de anotar cualquier fricción de T01**, porque le sirve a las 7 que vienen.
- **T09, T10 y T11 van al final por riesgo, no por dependencias.** Concentran aprobar, regenerar y
  guardar ediciones al plan. Cuando les toca, el sistema ya está probado en 5 pantallas.
- **El límite son las dependencias, no los slots.** Un cuarto agente en el paso 3 no acelera nada: no
  hay una cuarta pantalla que no dependa de T02.

**Si preferís ir de a uno:** el orden serial es T01 a T12, tal cual. Dejá T09, T10 y T11 para un
momento en que no estés generando nada, porque su QA a mano toca botones que cuestan plata.

---

## Preámbulo (va al inicio de cada prompt)

> Estás trabajando en `/Users/lucho/Desktop/funnel/videogeneradorxd`, una app Next.js 14 que genera
> anuncios e imágenes con Vertex AI. **Está en producción en https://generador.hilvanapp.online, la
> usan dos personas, y cada generación cuesta plata real.**
>
> Leé estos archivos completos antes de escribir código, en este orden:
> 1. `tasks/00-PLAN-REDISENO-UI.md`
> 2. `tasks/<TU-TASK>.md`
>
> Contexto que te ahorra tiempo: la fundación del sistema de diseño (tokens, primitivas de
> `src/components/ui/`, y el mapeo de estados de `src/lib/ui-tokens.ts`) **ya existe**, la escribió
> T01. No la reimplementes ni la mejores: usala.
>
> Reglas que no se negocian:
> - **Solo escribís los archivos de tu fila en §8 del plan.** Hay otros agentes trabajando en
>   paralelo. Si creés que necesitás tocar uno ajeno, anotalo en §10 y seguí.
> - **Hay una lista de archivos que NADIE toca** (§8): `src/lib/jobs/*`, `src/lib/providers/*`,
>   `config.ts`, `schema.ts`, `storage.ts`, `db.ts`, `auth.ts`, `middleware.ts`, `src/app/api/*`,
>   `src/store/useProjectStore.ts` y `deploy/*`. Son los caminos que gastan plata o que dejan a los
>   usuarios afuera de la app.
> - **No instalás dependencias ni editás `package.json`.** T01 declaró todo. Si falta algo, va a §10.
> - **No cambiás los contratos de §4, §5 ni §6.** Están congelados porque 11 tasks se escriben contra
>   ellos al mismo tiempo.
> - **Este rediseño es VISUAL.** No cambiás endpoints, ni payloads, ni la lógica de negocio, ni
>   refactoreás "de paso". Un rediseño que además refactorea no se puede revisar.
> - **Ningún color literal.** Ni `#hex`, ni `zinc-700`, ni `slate-800`. Solo los tokens de §4.
> - Castellano rioplatense con voseo en los comentarios y en el texto que ve el usuario. Los prompts
>   visuales que se le mandan a los modelos quedan en inglés, no se traducen.
> - **Al terminar, corré tu sección de Verificación COMPLETA y pegame la salida, incluido el QA a
>   mano.** Si algo falla, arreglalo antes de decir que terminaste. **"Compila" no es verificación:**
>   el modo de falla de este módulo es un botón desconectado, y eso compila perfecto.

---

## Paso 1

### T01 — Fundación

> [preámbulo, con `<TU-TASK>` = `T01-fundacion.md`]
>
> Ejecutá T01 completa: dependencias, tokens, tipografía y las 10 primitivas.
>
> Cuatro cosas con atención especial:
>
> **1. NO corras `npx shadcn init`.** Está verificado que rompe esta app (D1 del plan): la versión 4
> se cuelga y la 2.1.8 deja los 25 usos de `bg-accent` sin fondo por un `hsl(oklch(...))` inválido.
> Las primitivas se escriben a mano con CVA + Radix + `cn()`.
>
> **2. `tailwind-merge` en 2.6.1, no 3.x.** La 3 es para Tailwind v4 y acá hay 3.4.19. Con la 3 el
> merge deja pasar clases que deberían pisarse, y el bug se ve como "le puse una clase y no tomó",
> intermitente.
>
> **3. Dejá `ink`, `panel` y `accent` como alias en `tailwind.config.ts`.** Si los borrás ahora, la
> app entera queda sin estilos hasta que termine la última task, y es una app que se está usando. Los
> borra T12.
>
> **4. Las firmas de §5 son contrato.** Once tasks se escriben contra ellas mientras vos trabajás. Si
> alguna no se puede implementar tal cual, **pará y avisá**; no la cambies.

## Paso 2

### T02 — Componentes compartidos

> [preámbulo, con `<TU-TASK>` = `T02-componentes-compartidos.md`]
>
> Reescribí los 8 componentes de `src/components/` sobre las primitivas de T01.
>
> **Las props de cada componente son contrato**: 7 pantallas se están escribiendo contra ellas en
> paralelo. Leé cada archivo, anotá su interfaz, y cambiá solo el JSX de adentro.
>
> Lo más importante: **`StatusBadge` tiene un `switch` de estados propio y es una de las 4 copias
> divergentes que este módulo elimina.** Reemplazalo por `estadoDeJob()` de `ui-tokens`. Es la razón
> de que hoy `awaiting_approval` se vea de distinto color según la pantalla.
>
> En `SessionBar`, **no toques el `window.location.assign` del logout**: está ahí por un bug
> documentado en el propio archivo. Leé el comentario antes de "mejorarlo".
>
> Y anotá en §10 cuántos nodos renderiza `FlowGraph` con el VSL de 95 clips (`vsl-natalia-plan.json`
> en la raíz). Es el dato que falta para decidir P-03.

### T03 — JobCard

> [preámbulo, con `<TU-TASK>` = `T03-jobcard.md`]
>
> Reescribí `src/components/JobCard.tsx`, 544 líneas, sobre las primitivas.
>
> Tres cosas:
>
> **1. La interfaz `Props` es contrato**: 4 pantallas la usan, incluidas las tres de mayor riesgo.
>
> **2. Copiá `fileUrl()` tal cual, con el `?v=<updatedAt>` y el `key={url}` en los medios.** Están ahí
> por un bug real: sin eso, al regenerar una imagen el browser sirve la vieja de cache y parece que la
> regeneración no hizo nada. Si te parece que "queda más limpio" sin eso, anotalo en §10, no lo saques.
>
> **3. Esta tarjeta aparece hasta 95 veces en una pantalla.** `preload="none"` en los videos, y nada de
> animaciones por tarjeta salvo la que está generando.

## Paso 3

### T04 — Login

> [preámbulo, con `<TU-TASK>` = `T04-login.md`]
>
> Rediseñá el login. Es la pantalla más chica y va primero a propósito: **es la que estrena las
> primitivas de T01.**
>
> **Anotá en §10 cualquier fricción que encuentres con las primitivas.** Le ahorra el problema a las 7
> tasks que vienen.
>
> **No cambies `window.location.assign("/")` por `router.push`.** Leé el comentario del handler: la
> versión anterior hacía `router.refresh()` y eso provocaba que **la clave correcta diera un error del
> server mientras la clave incorrecta andaba bien**. Está arreglado; no lo reintroduzcas.
>
> En el QA a mano, el caso que no se puede saltear es entrar con la clave correcta y ver el nombre del
> usuario en el header.

### T05 — Home

> [preámbulo, con `<TU-TASK>` = `T05-home.md`]
>
> Rediseñá `src/app/page.tsx`, 805 líneas: los dos modos (brief y pegar JSON), los avatares de
> referencia y la lista de proyectos.
>
> **Lo más delicado es el panel de avatares.** Sube fotos y permite editar el `id` de cada una, y ese
> `id` es lo que el PlanJSON referencia en `ref_image_ids`. Si el mapeo se rompe, el VSL genera la cara
> equivocada y no te enterás hasta ver el video. Probalo a mano.
>
> **`src/store/useProjectStore.ts` es intocable.** Tiene el polling y la forma de datos que consumen 4
> pantallas. Si necesitás algo de ahí que no expone, va a §10.
>
> `/api/parse` tarda 15 a 20 segundos: el botón necesita estado de carga o el usuario lo aprieta dos
> veces.

### T06 — Imágenes

> [preámbulo, con `<TU-TASK>` = `T06-imagenes.md`]
>
> Rediseñá la pantalla de imágenes. Es la que el usuario usa más.
>
> Dos cosas que no se pueden romper:
>
> **1. El polling vive en un `ref` y se apaga cuando no queda nada en curso.** Si lo movés a
> `useState`, se reinicia en cada render y le pega a la API mucho más seguido. La pantalla queda
> abierta horas.
>
> **2. `editando` está separado de `prompts` a propósito**: si fueran uno, lo que estás tipeando se
> perdería cada vez que llega una respuesta del polling.
>
> Y el caso que hoy se ve mal: **cuando salen menos variantes de las pedidas (`1 de 2`), la tarjeta no
> puede verse como fallada.** Es estado legítimo, la cuota rechazó una. La nota de `job.error` explica.
>
> El QA a mano cuesta plata: hacelo con 2 prompts y 2 variantes, no más.

## Paso 4

### T07 — Tablero de lotes

> [preámbulo, con `<TU-TASK>` = `T07-batch.md`]
>
> Rediseñá el tablero. **Ojo con el ownership:** tocás `batch/page.tsx`, `BatchBoard.tsx` y
> `ClipTimeline.tsx`. Los `page.tsx` de `batch/review/` y `batch/videos/` son de T09 y T10.
>
> `ProjectCard`, `Progress` y `ProjectPicker` son internos del archivo: podés reorganizarlos pero **no
> los muevas a `src/components/`**, ese directorio es de T02.

### T08 — Resultado

> [preámbulo, con `<TU-TASK>` = `T08-result.md`]
>
> Rediseñá la pantalla de resultado. **Conservá el panel que muestra el JSON de todos los videos para
> copiar**: es una feature agregada a propósito.
>
> Si el archivo usa el cache-busting `?v=` en las URLs, copialo tal cual.

## Paso 5

Las tres de mayor riesgo. **Corré su QA a mano en un momento en que no estés generando nada**, porque
toca botones que cuestan plata.

### T09 — Deck de revisión

> [preámbulo, con `<TU-TASK>` = `T09-review.md`]
>
> Rediseñá el deck de revisión, 869 líneas. **Es la pantalla con más handlers de la app: 7 endpoints.**
>
> El riesgo concreto: un `fetch` perdido deja un botón de aprobar o regenerar que no hace nada, y eso
> **compila perfecto**. Contá los `fetch` antes y después (tienen que ser 7) y **apretá cada botón en
> el QA a mano**. No declares la task terminada sin eso.
>
> Ya hay un `EmptyState` local en el archivo: al usar el de T01, no dejes los dos con el mismo nombre.

### T10 — Deck de videos

> [preámbulo, con `<TU-TASK>` = `T10-videos.md`]
>
> Rediseñá el deck de videos, 628 líneas. 4 endpoints.
>
> **Agregá confirmación al botón de regenerar**, con `Dialog`. Es el único cambio de comportamiento que
> el plan autoriza, y está justificado: hoy es un click directo en una grilla densa, y un video de 8
> segundos son varios dólares.
>
> `preload="none"` en todos los videos, cero `autoplay`. Con 95 clips es la diferencia entre usable e
> inusable.

### T11 — Pipeline

> [preámbulo, con `<TU-TASK>` = `T11-pipeline.md`]
>
> Rediseñá el pipeline, **1187 líneas, el archivo más grande y de mayor riesgo del proyecto.** Leelo
> completo antes de tocar una línea.
>
> Cuatro cosas:
>
> **1. El export a ffmpeg lee del PLAN, no de los jobs.** Las ediciones del storyboard tienen que
> seguir persistiendo. **Si el guardado se rompe, las ediciones se pierden en silencio y aparecen
> recién en el video final.** El QA a mano tiene un paso específico: editar, guardar, recargar, y
> verificar que el cambio sigue. No lo saltees.
>
> **2. `SavePayload` no cambia de forma.**
>
> **3. Conservá el corte de 24 clips**: arriba de eso el pipeline arranca en `FixView`, que es la vista
> compacta con video on-demand. Es lo que hace usable el VSL de 95 clips.
>
> **4. Los tres botones de guardado hacen cosas distintas y tienen que distinguirse.** "Regenerar todos
> sin editar" va con confirmación y diciendo cuántos jobs, porque en un VSL de 95 clips cuesta decenas
> de dólares.

## Paso 6

### T12 — Limpieza y QA final

> [preámbulo, con `<TU-TASK>` = `T12-limpieza-y-qa.md`]
>
> Borrá los alias viejos y corré el QA final.
>
> **Primero probá que nadie usa `ink`, `panel` ni `accent`, después borralos.** Si quedan
> referencias, la pantalla que las usa quedó sin migrar: no borres, avisá. Borrar los alias con
> referencias vivas deja esa pantalla sin color y **no rompe el build**.
>
> Los dos pasos del QA que deciden si esto se puede mergear: el **5** (ningún endpoint perdido) y el
> **9** (los archivos intocables sin cambios respecto de `main`). Si alguno falla, una task rompió algo
> funcional o se salió de su fila.
>
> No arregles detalles visuales de pantallas ajenas: anotalos en §10 con el archivo y qué viste.

---

## Qué revisar cuando terminan

```bash
cd /Users/lucho/Desktop/funnel/videogeneradorxd

# 1 — compila y buildea, y las 8 rutas siguen ahi
rm -rf .next && npx tsc --noEmit && npm run build 2>&1 | grep -E "ƒ /" | grep -v "/api/"
#   esperado: /, /login, /imagenes, /batch, /batch/review, /batch/videos,
#             /project/[id]/pipeline, /project/[id]/result

# 2 — LA VERIFICACION QUE DECIDE: ninguna pantalla perdio una llamada a la API
bash tasks/_verificacion-endpoints.sh
#   esperado exactamente: SIN REGRESIONES

# 3 — las afirmaciones del plan siguen en verde
bash tasks/_verificacion-inventario.sh     # esperado: INVENTARIO COMPLETO
node tasks/_verificacion-contraste.mjs     # esperado: FALLOS: 0

# 4 — NADA DE LO QUE YA FUNCIONABA CAMBIO: los intocables, sin un solo cambio
git diff --stat main -- src/lib/jobs/ src/lib/providers/ src/lib/config.ts src/lib/schema.ts \
  src/lib/storage.ts src/lib/db.ts src/lib/auth.ts src/middleware.ts src/app/api/ src/store/
#   esperado: SIN SALIDA

# 5 — el sistema de diseño se respeto
grep -rE "#[0-9a-fA-F]{3,6}" src/ --include=*.tsx || echo "sin colores literales"
grep -rln "awaiting_approval" src/ --include=*.tsx || echo "ninguna pantalla mapea estados sola"
#   esperado: las dos frases

# 6 — el login sigue funcionando (es lo que da acceso a todo lo demas)
#     con la app corriendo, y con la password real:
#     curl -X POST .../api/login -d '{"usuario":"ivan","password":"..."}'
#   esperado: {"ok":true,"usuario":"ivan"}

# 7 — el circuito completo, a mano: la tabla del §4 de T12, pantalla por pantalla

# 8 — el estado final es el seguro: ningun proyecto quedo generando de las pruebas
#     revisar /batch y cancelar lo que haya quedado corriendo

# 9 — leé las preguntas abiertas que quedaron en §10 del plan
```

**Si el paso 2 o el paso 4 no dan lo esperado, no se mergea.** Los dos detectan la misma clase de
problema, que es la única que este módulo puede introducir de forma grave: que algo que funcionaba
dejó de funcionar sin que nada avise.
