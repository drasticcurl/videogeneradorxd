# Bitácora de implementación

Registro por tarea de trabajo de implementación multi-paso: qué se hizo, qué se decidió sin
especificación explícita (y por qué), y qué falta verificar. Entradas en orden cronológico; no se
edita una entrada vieja, se agrega una nueva si hay que corregir algo.

---

## 2026-09-25 — Cambio de voz (ElevenLabs) — T00 a T07

**Pedido:** implementar el módulo "cambio de voz" con el plan de `tasks/cambio-de-voz/` (requisitos,
diseño con contratos congelados y 9 tasks), empezando con todas las tareas.

**Estado:** T00-T07 hechas, de a una en el orden del plan (T00 → T01 → T04 → T02 → T03 → T05 → T06 →
T07). T08 (producción) queda para hacer con el usuario.

### Lo que midió T00 (ElevenLabs real)

Video `01_pregunta-2.mp4` (45 s de Veo, habla continua); los tramos de 60 y 270 s repiten ese audio.

| Tramo | Δ duración | Corrimiento | Latencia |
|---|---|---|---|
| 20 s (quitar ruido on) | +16 ms (0,08 %) | -28 ms | 5,4 s |
| 20 s (quitar ruido off) | +16 ms | -42 ms | 4,3 s |
| 60 s | +22 ms (0,04 %) | -17 ms | 14,3 s |
| 270 s (23,8 MB) | +15 ms (0,01 %) | -15 ms | 56,4 s |

El diseño de piezas contiguas (D5) queda tal cual. La key de prueba no tiene `user_read` ni
`models_read`: los créditos por pedido (P-01) quedaron sin medir y el diálogo no puede mostrar los
créditos restantes con esa key. `wav_44100` → 403 `output_format_not_allowed` (P-03 resuelta: queda mp3).

### Decisiones tomadas sin especificación explícita

- **Paso 3 de §9 en dos pasadas:** primero se decodifica la salida (con el offset) para MEDIR su largo en
  muestras, y después se corre el comando de §9 tal cual sobre el archivo original. §9 pide medir "con
  ffprobe, después del offset"; la duración de formato de un mp3 es estimada por bitrate, así que se
  mide sobre PCM.
- **ffprobe sin `spawnSync` en el motor:** `audio.ts` usa `execFile` asincrónico para medir y un
  `execFileSync` de `-version` (milisegundos, una vez por proceso) para saber si existe. El chequeo de
  T03 prohíbe `spawnSync` en `audio.ts`/`corrida.ts`.
- **Una versión "cancelada" no se vuelve a escribir:** si un tramo termina justo después del cancelar,
  `actualizarVersion` no la revive. Sin eso, el progreso del tramo pisaba el "cancelada".
- **El 403 de ElevenLabs cae en `otro`** con el mensaje de ElevenLabs: la tabla de §6.2 no lo tiene.
  Anotado como P-07, no decidido en el código.
- **Descarga con nombre legible:** sale del nombre del archivo sin el `-<id6>` final; así la UI no
  necesita duplicar `slugify` (que vive en `storage.ts`, con `node:fs`).
- **UI funcional:** Resultado se mide sobre un segundo proyecto sembrado con `autoApprove` propio y
  unido; el primero sigue en modo manual para el editor de clip.

### Lo que aprendí y conviene tener presente

- **El atributo `hidden` pierde contra una clase de display.** El panel de ajustes con `hidden` y
  `className="flex …"` se veía abierto con la flecha cerrada. Se vio en una captura, no en un chequeo.
- **Mientras un clip se regenera no tiene archivo**, así que el unido figura "Se sacaron clips" hasta
  que termina, y recién ahí "El clip 02 se regeneró". El E2E primero esperaba el primer estado; es
  correcto que se vea así.
- Los chequeos por grep (`process.env`, `AbortSignal.any`, `db.json`) también encuentran comentarios
  que explican por qué NO se usan. Se reescribieron esos comentarios en vez de relajar el grep.

### Números del E2E (mock)

Unido de 30,06 s (4 clips): versión con md5 de video idéntico, las mismas muestras de audio, c1+c2 en
275 Hz (convertidos), c3 filmado en 660 Hz y c4 sin diálogo en 220 Hz (conservados, más de 10 dB por
encima de la otra banda). Prueba de 20,0 s. 409 al unir con conversión viva, cancelar sin
`_trabajo/`, desactualizado → 400 → volver a unir, zip con la versión y sin la prueba, 404 para otro
usuario, carpeta del proyecto borrada a mitad de una conversión que no reaparece.

### Pendiente (T08, con el usuario)

- **P-01:** créditos reales por pedido (la key de prueba no deja leerlos; mirar el panel de ElevenLabs).
- **P-02:** listar modelos con una key con `models_read` (el vigente funciona).
- **P-04:** unir un VSL largo sigue pasando los 100 s de Cloudflare (preexistente; hay mensaje honesto).
- **P-05:** salto de volumen entre lo convertido y lo conservado: escucharlo en un proyecto real.
- **P-06:** voces de la Voice Library en el plan del usuario.
- **P-07:** mapeo del 403 de ElevenLabs.
- La key usada en el spike se pegó en el chat de la sesión: **rotarla** antes de ponerla en producción.

---

## 2026-09-23 (3) — Auditoría de UI (pantalla chica y normal)

**Pedido:** "audita la ui en pantalla chica sacando screen y en pantalla normal, revisá que todo
funcione correctamente".

**Estado:** hecha. 40 combinaciones medidas + 21 pruebas funcionales x 2 tamaños, 3 defectos
encontrados y arreglados, capturas en `~/Desktop/auditoria-ui-augc/`.

### Cómo se armó

El instrumental de `tasks/_verificacion-ui-funcional.mjs` alcanzaba para los botones, pero una
auditoría necesita datos representativos: se sembraron los 8 casos que la app puede mostrar (video con
video final unido por ffmpeg real, modo manual con clips esperando, VSL de 24, tandas de imágenes de
4 y 2 variantes, y una tanda masiva de 3 proyectos con prompt dual). Sin eso se auditan pantallas
vacías, que es justo donde nada se rompe.

Dos scripts separados, y la separación importa: uno mide GEOMETRÍA (desborde sin scroll, cajas
superpuestas, scroll horizontal, controles < 24px, texto recortado) y saca la captura; el otro prueba
COMPORTAMIENTO con clicks y verifica el efecto contra la API, no contra el DOM.

### Decisiones y hallazgos que conviene recordar

- **`overflow-y: auto` no es sólo vertical.** El navegador computa `overflow-x: auto` y recorta
  horizontalmente. Cualquier elemento posicionado por fuera de la caja (una manija, un badge que
  sobresale, un tooltip) queda cortado. Fue la causa del defecto 1 y es un error fácil de repetir.
- **El detector de "controles chicos" tuvo 89 falsos positivos la primera corrida**, todos elementos
  `sr-only`, que miden 1x1 *a propósito*. Se filtran por la clase. Vale la pena anotarlo: un
  verificador con demasiado ruido es uno que se ignora.
- **Tres de las cuatro "fallas" de la primera corrida funcional eran de MI instrumento, no de la app**:
  "Armar tablero" es un `<a>` (Button asChild + Link) y yo buscaba un `<button>`; el wizard deshabilita
  "Siguiente" hasta que hay brief (correcto, con el hint "Pegá el brief para poder interpretarlo"); y
  el drag de CDP necesita `buttons: 1` en el `mouseMoved`. Antes de reportar un bug conviene descartar
  el instrumento — pero la cuarta era real.
- **Las pruebas funcionales consumen su propio dato**: al aprobar clips en una corrida, la siguiente no
  encuentra nada por aprobar y "falla". Se resolvió desaprobando con el endpoint antes de repetir. Si
  esto se vuelve parte del flujo habitual, conviene que el script siembre su propio proyecto
  descartable en cada corrida.
- **No correr `npm run build` con el dev server arriba**: comparten `.next/` y el script empieza a
  recibir HTML donde espera JSON, con un error que no explica nada. Quedó anotado en el encabezado del
  verificador.

### Pendiente

- El máximo del panel de clip (`innerWidth - 360`) viene del handoff, pero en 1280px deja la lista de
  clips en 360px para 6 columnas. Es el contrato, no un bug; si se quiere cambiar, es ese número.
- Los checkboxes de selección miden 16x16 (el default nativo). WCAG 2.5.8 pide 24x24 de target, con
  excepción por separación. Preexistente, no se tocó para no cambiar todos los formularios de la app.

---

## 2026-09-23 (2) — "Aprobar clip" y "Extender +7s" desconectados por el rediseño

**Pedido:** "me desapareció el botón de aprobar clip".

**Estado:** hecha, verificada apretando el botón en la app real (no sólo leyendo código).

### El diagnóstico, y la pregunta que lo abrió

Lo primero fue no asumir. En `/batch/videos` el botón existía y estaba bien condicionado
(`item.status === "awaiting_approval"`), así que el problema estaba en el pipeline. El chequeo que lo
encontró rápido fue listar **qué acciones del store extrae la página y dónde se consumen**: `approveJob`
y `extendJob` estaban importadas y envueltas en `useCallback`, pero el objeto `handlers` que las
transporta sólo llegaba a las tarjetas de imagen. El `ClipEditor` recibía `onSave`, `onRegenerate` y
`onChangeResolution`, y nada más.

Ese barrido también destapó el segundo caso: "Extender +7s" no estaba inalcanzable *en el pipeline*,
estaba inalcanzable **en toda la app**, con el endpoint vivo y documentado.

### Decisiones tomadas sin especificación explícita

- **Se replicaron las condiciones de `JobCard` en vez de inventar nuevas**: aprobar con
  `status === "awaiting_approval"` (que era `estado.tone === "attention"`) y extender con
  `job.outputPath`. Si el criterio de cuándo se puede aprobar algo cambia, tiene que cambiar en un solo
  lugar, y ese lugar no es este editor.
- **`onApprove` se adapta a un argumento** al pasarlo al editor. El de la página acepta
  `(id, index?)` porque las imágenes eligen cuál de las N variantes se aprueba; un clip de video no
  tiene variantes. Pasarlo tal cual dejaba abierta la puerta a mandar un índice y que el backend
  aprobara la variante 0 de un job que no las tiene.
- **`/api/projects/[id]/stage` NO se borró** aunque está huérfano desde `6069ed6`: está documentado en
  el README y borrar un endpoint es un cambio de API, no limpieza. Queda como excepción con el motivo
  en el verificador nuevo, y anotado acá para que la decisión sea visible.
- **Dos verificadores y no uno**, porque hacen cosas distintas y uno solo no alcanza:
  el estático corre en un segundo y caza que se borre el último llamador; el funcional abre Chrome y
  caza lo que al estático se le escapa. Probé el estático simulando la pérdida y **siguió diciendo
  OK** — lo dejé escrito en su propio encabezado para que nadie confíe de más en él.

### Lo que aprendí de esto y conviene tener presente

La firma de este bug es: *endpoint vivo + acción del store viva + typecheck verde + botón inexistente*.
Se da cuando se reemplaza un componente por otro y los callbacks se siguen creando pero cambian de
destinatario. Un `grep` no lo ve porque todos los identificadores siguen ahí. La única defensa barata
es abrir la pantalla y buscar el botón, que es lo que ahora hace
`tasks/_verificacion-ui-funcional.mjs`.

**Cómo correrlo** (necesita la app en mock en :3100, el comando exacto está en el encabezado del
script):

    node tasks/_verificacion-ui-funcional.mjs

---

## 2026-09-23 — Arreglo de layout en laptop (pipeline, resultado, /imagenes)

**Pedido:** "revisá la ui dentro de un video, en mi laptop se ve mal, se superponen cosas y queda
horrible", con la referencia del handoff `design_handoff_rediseno_augc`.

**Estado:** hecha y verificada visualmente, que era justo lo que faltaba en la entrada anterior.

### Cómo se midió (vale para la próxima vez)

No había forma de verificar esto leyendo código: la superposición es geometría, no sintaxis. Se armó
un instrumental sin instalar dependencias, aprovechando que macOS ya trae Chrome y que Node 24 tiene
`WebSocket` global:

1. `npx next dev -p 3100` con `PROVIDER_MODE=mock`, `DATA_DIR`/`OUTPUT_DIR` en `/tmp` y un
   `PASSWORD_TEST`, para no tocar nada real.
2. Un script siembra por API un proyecto de video (6 clips) y otro de 24 clips en modo manual, y los
   genera en mock (gratis).
3. Chrome en `--headless=new --remote-debugging-port=9222`, manejado por CDP con un driver de ~40
   líneas: `Network.setCookie` para la sesión, `Emulation.setDeviceMetricsOverride` para el tamaño,
   `Runtime.evaluate` para el diagnóstico y `Page.captureScreenshot` para mirar.
4. El diagnóstico reporta tres cosas: elementos cuyo rect se sale del viewport **sin que ningún
   ancestro scrollee** en ese eje, pares de cajas hermanas que se solapan, y el presupuesto vertical
   (el alto y el `flex` de cada hijo del shell).

Ese cuarto punto es el que encontró el bug en el primer intento: `+756px` en
`section.flex-none` de la sección de imágenes. El presupuesto vertical es el dato que hay que mirar
primero en cualquier pantalla de alto fijo.

### Decisiones tomadas sin especificación explícita

- **La sección de imágenes y el log van adentro del scroll de los clips**, como props `encabezado` y
  `pie`, en vez de ser hermanos del grid. La alternativa era darle `overflow-y-auto` a la sección de
  imágenes, pero eso deja dos scrolls anidados en la misma columna y el de adentro se traba cuando
  llega al final. El handoff no pone ni imágenes ni log en esta pantalla, así que meterlos en el
  scroll es lo más cerca del spec sin borrar funcionalidad.
- **Colapsada siempre**, y se borró `UMBRAL_VISTA_LIVIANA` en vez de bajarlo a 0: una constante que
  siempre da el mismo resultado es peor que no tenerla, porque hace creer que hay un caso donde
  cambia. El comentario que documentaba el umbral quedó, reescrito, explicando por qué se fue.
- **`auto-fill minmax(200px,1fr)` y no 160px**: con 160 las tarjetas daban 169px y el id seguía
  cortado (`scrollWidth > clientWidth` en "avatar1_base"). 200 da 3 columnas de ~229px y entra. El
  número salió de medir, no de estimar.
- **Las miniaturas de Resultado son un `<a>` al archivo**, no un video sin controles ni un player
  custom: es lo que hacía el `ClipTimeline` viejo, no necesita JS y abre el clip a tamaño real, que es
  lo único que se le pide a una miniatura de 72px.
- **`/imagenes` abre la primera tanda sola**, condicionado a `vista === "galeria"` para no cambiarle la
  pantalla a alguien que está en el formulario de "Nueva tanda", y con `router.replace` para que el
  botón de atrás del navegador salga de `/imagenes` en vez de recorrer las tandas que se abrieron
  solas.

### Lo que quedó pendiente

- A 960x600 (zoom 150%) el pipeline no se superpone pero sí queda apretado: la tabla de clips trunca
  el id y el diálogo. Es usable; si alguien trabaja siempre así, convendría que abajo de ~1100px el
  editor de clip pase a ser una capa sobre la lista en vez de una columna al lado.
- El instrumental de medición quedó en `/tmp` y no en el repo. Si esto se repite, vale hacerlo un
  script versionado en `tasks/`.

---

## 2026-09-22 — Rediseño de las 4 pantallas (handoff `design_handoff_rediseno_augc`)

**Pedido:** implementar el handoff de rediseño de `/imagenes`, `/project/[id]`, `/` y `/batch` con
los componentes de `@/components/ui`, los tokens de `tailwind.config.ts` y `ui-tokens.ts`, sin tocar
endpoints, payloads ni reglas de negocio. Los `.dc.html` del handoff son prototipos de referencia, no
código para copiar. Cerrar con commits y push a producción.

**Estado:** hecha. 5 commits. Verificada con `npx tsc --noEmit` (0 errores), `npm run build` (10/10
páginas, sin warnings), `tasks/_verificacion-endpoints.sh` (SIN REGRESIONES),
`_verificacion-cn.mjs` y `_verificacion-contraste.mjs` (0 fallos), y un grep que confirma que no
entró ni un color literal en el código nuevo. **No verificada visualmente en navegador**: no había
entorno de preview en la sesión. Eso es lo único que falta para darla por 100% cerrada.

### Cómo se dividió

Cinco commits, uno por unidad coherente, y el primero es la base de la que dependen los otros cuatro:

1. `13a618a` shell de alto fijo + primitivas compartidas
2. `9714af3` parte 1 — `/imagenes`
3. `3c6c7e2` parte 2 — `/project/[id]` pipeline y resultado
4. `0375350` parte 3 — home y wizard
5. `8a0b0a7` parte 4 — tablero y revisión unificada

Las cuatro partes se implementaron en paralelo con ownership de archivos disjunto. Para que eso fuera
posible sin que se pisaran, las piezas compartidas se escribieron PRIMERO y se commitearon aparte:
sin eso, cada parte habría inventado su propio segmented, su propia barra de progreso y su propio
mapeo de estado a color, que es exactamente el problema que `ui-tokens.ts` documenta haber resuelto
para los badges.

### Decisiones tomadas sin especificación explícita

- **`main` sin max-width ni padding, y cada página elige su contenedor.** La alternativa era que el
  layout envolviera todo en un scroll y que las pantallas fijas se salieran de ahí con `h-full`, que
  funciona pero es frágil: cualquiera que agregue un wrapper en el medio lo rompe sin error. El costo
  es que hubo que envolver las 8 páginas; el beneficio es que el contrato es explícito.
- **`.cq-size` en `globals.css` a mano.** `container-type: size` no existe en Tailwind 3.4: el plugin
  oficial de container queries solo genera `inline-size`. Con `inline-size`, `100cqh` no resuelve y el
  medio crece hasta desbordar, o sea vuelve el scroll que el rediseño saca.
- **`MiniTimeline` con ancho proporcional (`flex-grow = duracionSeg`) en vez de px fijos.** El
  `ClipTimeline` viejo daba `width: max(14, duracionSeg * 4)`, que con 95 clips son 3040px de tira y
  scroll horizontal. Con `flex-grow` los 95 entran en el ancho que haya y la proporción entre
  duraciones se mantiene.
- **`Segmented` es `radiogroup`, no `tablist`.** No hay ningún `tabpanel` asociado en los cinco
  lugares donde se usa, y anunciar pestañas que no existen le miente al lector de pantalla. Solo la
  opción activa es tabulable: con las cinco en el orden de tabulación, llegar al contenido de la
  galería costaba cuatro tabs de más.
- **La revisión unificada es UN componente que montan las dos rutas, no un redirect.** Navegar entre
  `/batch/review` y `/batch/videos` al tocar el segmented remonta el árbol y se pierden `lockRef`,
  `resolved`/`skipped` y los candados de doble acción. Las dos URLs siguen existiendo, así que los
  bookmarks y el historial no cambian.
- **La home agrega `GET /api/batch?ids=`.** Es el único fetch nuevo de toda la tanda. Es de lectura,
  el endpoint ya existía, y hace falta porque `GET /api/projects` no devuelve desglose de jobs ni
  duración de clips, y las cards del handoff piden mini-timeline + dos barras + "N clips esperan tu
  aprobación". Va best-effort: si falla, la card cae a su versión básica y el listado no se rompe.
- **Se borraron tres componentes que quedaron sin un solo import:** `ProjectTabs.tsx`,
  `FlowGraph.tsx` y `ClipTimeline.tsx`. Los tres tienen reemplazo (el segmented del header, `Etapas`
  y `MiniTimeline`), así que no se fue ninguna funcionalidad. Se borran y no se dejan muertos porque
  un componente sin uso es lo que alguien copia dentro de seis meses creyendo que es el vigente.
- **Resultado tiene DOS layouts.** Con video final es de alto fijo (el video a `100cqh`, scrollea la
  columna de al lado, que contiene descargas + clips + JSON). Sin video final scrollea como una lista
  normal: ahí no hay nada que dimensionar contra el alto y forzarlo solo achica la grilla de clips,
  que es lo único que hay para mirar. La primera versión usaba `70vh` fijo y volvía a meter scroll de
  página en un monitor bajo.
- **El bloque "Prompt" del header de `/imagenes` quedó editable**, no de solo lectura como el
  prototipo: es donde se edita el prompt antes de "Variar", y dejarlo read-only sacaba esa función
  sin reemplazo.
- **`_verificacion-endpoints.sh`: se actualizó la `LINEA_BASE`** con los cuatro movimientos y su
  motivo en el encabezado, que es lo que el propio script pide cuando un fetch se mueve a propósito.
  Se verificó que el conjunto de endpoints que la app llama es el mismo de antes más el GET de
  lectura de la home.
- **Detalle que costó una regresión falsa:** el comentario que expliqué en el pipeline contenía el
  literal `/api/` y el script de verificación lo contó como endpoint nuevo. El script grepea el
  archivo entero, comentarios incluidos. Quedó anotado en el propio comentario.

### Limitaciones conocidas que quedan

- La meta del header de una tanda en `/imagenes` no muestra la calidad (1K/2K/4K) que pedía el
  handoff: `/api/projects/:id/jobs` no la expone a nivel de proyecto y agregarla era tocar `lib/`,
  que está fuera del alcance de un rediseño visual.
- Falta la pasada visual en el navegador: las 4 pantallas están verificadas por typecheck, build,
  los tres scripts de verificación y lectura de código, pero nadie las vio renderizadas.

---


---

## 2026-09-21 — Tablero `/batch`: arrancar proyectos de a UNO (no en paralelo)

**Pedido:** el usuario reportó que con 30 proyectos en un tablero, al apretar "seguir", todos
fallaron por 429 en cascada tras agotar los reintintos. Pidió que el tablero genere de a un
proyecto a la vez, igual que ya hace el generador masivo de imágenes.

**Estado:** hecha. Sin build/typecheck corridos (prohibido salvo pedido explícito). Verificada por
lectura completa del flujo (`queue.ts`, `masivo.ts`, `batch/route.ts`, `imagenes/masivo/route.ts`) y
`grep` de todos los usos de `enqueueProject` en `src/` para confirmar que no quedó otro punto con el
mismo bug.

### Causa raíz confirmada

`POST /api/batch` (`start-images`/`start-videos`) hacía `enqueueProject(project.id)` en un loop
sobre los N proyectos del tablero. La concurrencia de la cola (`PIPELINE_CONCURRENCY`, default 3) es
GLOBAL y no distingue de qué proyecto es cada job: con 30 proyectos, cada slot que se libera lo toma
el job pending de CUALQUIER proyecto, así que la cola sostiene 3 requests simultáneas contra el
mismo modelo sin pausa mientras haya trabajo pendiente en cualquiera de los 30. Eso agota el
presupuesto de 10 reintentos de rate limit (aparte de los intentos normales del job) y el job queda
`failed`. El comentario original del código decía "arrancar 5 proyectos juntos genera el mismo rate
de requests que arrancar uno" — es la asunción incorrecta que causó el bug: la concurrencia nominal
es la misma, pero la cantidad de trabajo disponible para llenarla escala con N proyectos, y eso es lo
que golpea la cuota real.

### Diseño elegido: reusar `startBatch`/`notifyProjectFinished` de `jobs/masivo.ts`

El generador masivo (`/imagenes`, pestaña "Generador masivo") ya resolvía exactamente este problema
con un mecanismo secuencial genérico (`startBatch(batchId, projectIds, enqueueProject)` encola solo
el primero; `notifyProjectFinished` engancha en `queue.ts`/`finalizeProjects` y encola el siguiente
cuando el anterior termina). Se decidió reusar ese mismo módulo en `/api/batch` en vez de escribir
una cola secuencial nueva, para no duplicar la lógica de cursor/estado por batch.

**Decisión no especificada explícitamente — por qué `finalizeProjects` necesitó un cambio propio:**
`notifyProjectFinished` originalmente solo se llamaba cuando un proyecto llegaba a un status
TERMINAL (`done`/`partial`/`failed`). Eso alcanza para el generador masivo porque fuerza
`autoApprove: true` en sus proyectos. Pero `/api/batch` (`start-images`/`start-videos`) deja
`autoApprove: false` por default (modo manual, a propósito, para que el usuario revise antes de
gastar en Veo) — en ese modo un proyecto NUNCA llega solo a un status terminal, se frena en
`review`/`awaiting_approval` esperando aprobación humana indefinidamente. Sin tocar nada más, el
proyecto 2..N del tablero jamás habría arrancado. Se agregó el mismo llamado a
`notifyProjectFinished` en la rama de `finalizeProjects` donde el proyecto se desactiva por no tener
más trabajo runnable y quedar todo en `awaiting_approval` (justo donde ya existía el guard de "no
desactivar si hay un reintento con backoff programado"). El criterio: "ya no le va a pedir más nada a
la cola por sí mismo" es la señal correcta para dejar pasar al siguiente proyecto de la tanda, sea
que terminó de verdad o esté esperando revisión (que el usuario puede hacer en paralelo mientras el
siguiente proyecto genera sus imágenes/videos).

El guard existente de `notifyProjectFinished` (`if (idx !== batch.cursor) return`) ya cubre, sin
tocarlo, el caso de que un mismo proyecto dispare el hook más de una vez (por ejemplo un proyecto de
video con `PIPELINE_APPROVAL_BATCH_VIDEOS=5` que cae en la rama `awaiting` varias veces a medida que
se aprueban lotes de 5 clips): solo la primera llamada avanza el cursor, las siguientes son no-op.

### Archivos modificados

- `src/app/api/batch/route.ts` — el loop de `start-images`/`start-videos` ya no llama
  `enqueueProject` por proyecto; acumula los ids en `toStart[]` (arma plan/jobs de todos primero,
  igual que antes) y llama `startBatch(randomUUID(), toStart, enqueueProject)` una sola vez al final.
  Import nuevo: `randomUUID` de `node:crypto`, `startBatch` de `@/lib/jobs/masivo`.
- `src/lib/jobs/queue.ts` — en `finalizeProjects()`, rama `awaiting_approval`: se agregó
  `notifyProjectFinished(projectId, enqueueProject)` dentro del `if (!conReintentoProgramado)` que ya
  desactivaba el proyecto. Import nuevo: ninguno (`notifyProjectFinished` ya estaba importado para la
  rama terminal).
- `src/app/batch/BatchBoard.tsx` — el `title` (tooltip) del botón "Comenzar imágenes" decía "Encola
  todos los proyectos en fase imágenes", desactualizado con el comportamiento nuevo. Cambiado a
  "Arranca los proyectos en fase imágenes de a uno, para no saturar la cuota".
- `CHANGELOG.md` — entrada agregada arriba, mismo formato que las entradas anteriores.

### Qué falta para verificación completa

- No se corrió `npm run typecheck` ni `npm run build` (prohibido por steering salvo pedido
  explícito). Los cambios son pequeños y localizados; recomendable correr `typecheck` antes de
  deployar a producción, dado que tocan la cola de jobs.
- No se probó en runtime (mock o vertex) un tablero real con N>1 proyectos en modo manual para
  confirmar que el segundo proyecto arranca solo tras que el primero queda en `awaiting_approval`.
  Sería la verificación más directa: crear 2-3 proyectos de imágenes, ponerlos en un tablero,
  apretar "Comenzar imágenes", y confirmar en los logs que el proyecto 2 no empieza a generar hasta
  que el 1 termina sus jobs (aunque queden sin aprobar).
- No se revisó el caso `start-videos` con `autoApproveVideos: true` en profundidad más allá de
  confirmar que cae en la rama terminal existente (ya cubierta por el mecanismo sin cambios).

---

## 2026-09-19 — `/imagenes`: imagen base subida (image2image) + chat iterativo con historial

**Pedido:** agregar a `/imagenes` la posibilidad de (1) subir una imagen propia como base para
generar (image2image en vez de text2image), y (2) un chat iterativo que encadene modificaciones
sucesivas sobre la última imagen aprobada, mostrando **todo** el historial (imagen 1 → prompt →
imagen 2 → prompt → imagen 3...), no solo la última.

**Estado:** hecha. Sin build/typecheck corridos (prohibido salvo pedido explícito). Verificada por
lectura completa de cada archivo tocado/creado más los scripts de verificación existentes del repo
(ver abajo).

### Diseño elegido

El plan (`ProjectPlan`, `src/lib/schema.ts`) ya soportaba el 90% de esto sin cambios: una `Image`
puede ser `image2image` con `ref_image_id` apuntando a otra `Image` del mismo proyecto (mecanismo
que ya usa el flujo VSL para encadenar planos con la misma identidad), o a una `reference` subida
por el usuario (mecanismo que ya usan los avatares). Se decidió **reusar ambos tal cual**, sin
tocar el schema ni el pipeline (`buildJobs`, `runImageGeneration`, `approveJob`), por dos motivos:
evitar duplicar las reglas de validación cruzada que ya vive en `validatePlan`, y porque el steering
del proyecto marca `pipeline.ts`, `queue.ts` y `schema.ts` como archivos con verificación de "no
tocar" en `tasks/_verificacion-inventario.sh`.


**Imagen base subida → se modela como `reference`, no como un concepto nuevo.** Mismo camino que
`POST /api/projects/:id/references` (VSL): se guarda el archivo en `references/<id>.<ext>`, se
agrega a `plan.references[]`, y la primera `Image` del asset queda `image2image` con
`ref_image_id` apuntando a esa reference. Decisión propia: el id de la reference es
`<assetId>_base` (no expuesto al usuario, sólo interno) — no hay especificación de nombre en el
pedido, y este evita colisión con el `imageId` real del proyecto.

**Cada turno del chat → una `Image` NUEVA, no un edit de la existente.** Se evaluó reusar
`changePrompt` + `regenerate` (ya existía), pero ESE camino reemplaza el job/archivo existente: es
lo opuesto a "ver el historial completo". Se optó por un endpoint nuevo,
`POST /api/projects/:id/images`, que agrega una `Image` con `ref_image_id = fromImageId` al mismo
asset. Decisión propia sobre el id: `<base>_v<n>`, donde `base` es `fromImageId` con el sufijo
`_v\d+` quitado (para no anidar `_v2_v3` si se sigue el chat varias veces) y `n` es el primer
entero ≥2 no usado en ese asset (v1 es la imagen original, sin sufijo, creada por
`imageIdPara` en `/api/imagenes`). No hay uuid: el nombre de archivo resultante
(`images/<slug>_v2.png`) queda legible, siguiendo la misma convención de nombres del resto del
proyecto.

**Historial en el cliente, no un GET nuevo.** El manifest (`buildManifest` en `storage.ts`) ya
expone `ref_image_id` por imagen (`ManifestImage`), así que `ImagenesBoard.tsx` arma el árbol de
cadenas (`hilos`, memoizado) enteramente del lado del cliente a partir de lo que ya trae
`GET /api/projects/:id/jobs`. Se agregó además `buildChatHistory` en `src/lib/imagenes.ts` (server)
como helper de respaldo: la usa el endpoint nuevo para devolver la cadena ya ordenada en la
respuesta de POST, útil como chequeo cruzado contra lo que el cliente calculó solo, y por si en el
futuro hace falta un GET de solo lectura del historial (no se creó ese GET: no había necesidad
concreta todavía, y hubiera sido una ruta sin consumidor).

**Validación de que la imagen base del turno esté aprobada.** El endpoint nuevo rechaza (400) un
`fromImageId` que no tenga `status: "done"` + `outputPath`, ANTES de tocar el plan. Sin este check,
el turno se crearía igual y fallaría más tarde, dentro de la cola, con un mensaje menos claro
(`runImageGeneration` ya tiene ese guard para el caso VSL: "La imagen de referencia todavía no está
aprobada"). Decisión: duplicar el check en el borde de la API para dar un 400 legible al usuario en
vez de un job que nace y muere.

### Archivos tocados

- `src/lib/imagenes.ts` — agregado `chatTurnImageId`, `ChatTurn`, `buildChatHistory`.
- `src/app/api/imagenes/route.ts` — acepta multipart/form-data con campo `imagenBase` opcional.
  Sin ese campo, comportamiento idéntico al anterior (mismo JSON, misma validación).
- `src/app/api/projects/[id]/images/route.ts` (nuevo) — `POST` que agrega un turno de chat.
- `src/app/imagenes/ImagenesBoard.tsx` — input de archivo + preview (con
  `URL.createObjectURL`/`revokeObjectURL`), estado y UI del chat (`hilos`, `HiloChat`,
  `enviarTurnoChat`), el render de resultados pasa de iterar `jobs` planos a iterar `hilos`.

### Qué falta para verificación 100%

- **No se corrió `npm run build` ni `npm run typecheck`** (prohibido por el steering salvo pedido
  explícito del usuario). Se verificó por lectura cuidadosa de tipos/imports/JSX balanceado en cada
  archivo, y corriendo los dos scripts de verificación existentes del repo:
  - `bash tasks/_verificacion-endpoints.sh` → `SIN REGRESIONES` (el fetch nuevo a
    `/api/projects/${id}/images` cae bajo el prefijo `/api/projects/` que la línea base de
    `ImagenesBoard.tsx` ya esperaba, así que no hizo falta tocar `LINEA_BASE`).
  - `bash tasks/_verificacion-inventario.sh` → los archivos intocables
    (`pipeline.ts`, `queue.ts`, `schema.ts`, `storage.ts`, `db.ts`, `auth.ts`, `middleware.ts`,
    providers de Vertex) siguen presentes y no fueron tocados.
- **No se probó en runtime** (no se levantó el server ni se generó una imagen real, mock o vertex).
  Falta: correr `npm run dev`, subir una imagen base, confirmar que la primera generación sale
  image2image (revisar `pipeline.log` o el prompt exacto vía `GET /api/jobs/:id/preview`), aprobar,
  mandar un turno de chat, confirmar que aparece v2 encadenada y que el historial se ve completo.
- **Efecto secundario conocido y aceptado**: `variantes` en el turno de chat es un campo de
  `ProjectRecord.imageVariants` (por PROYECTO, no por imagen — así está diseñado en todo el resto
  del pipeline, no es algo nuevo de este cambio). Si se pide un número de variantes distinto en un
  turno, ese valor queda como default también para futuros turnos y se refleja en el campo
  `variants` mostrado de imágenes ya aprobadas (no las regenera, sólo cambia el número que se les
  muestra). Documentado en el comentario del endpoint.

### Bloqueadores

Ninguno. No se necesitó ninguna decisión de negocio pendiente ni dependencia externa no disponible.
