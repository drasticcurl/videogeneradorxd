# Registro de cambios

Toda tanda de cambios se anota acá, arriba. Formato: fecha, qué cambió y **por qué** (el bug que
evita o el problema que resuelve). El detalle línea por línea vive en `git log`; esto es para
entender el estado sin leer 70 commits.

---

## 2026-09-26 (3) — El lote de clips antes de pedir aprobación es de cada usuario

**El problema:** en modo manual, la cola genera hasta 5 clips sin aprobar por proyecto y frena hasta que
alguien los apruebe. Ese 5 era uno solo para todos (`PIPELINE_APPROVAL_BATCH_VIDEOS`) y cambiarlo era
tocar el `.env` del server y desplegar. Cuánto se gasta en Veo sin mirar es una decisión de cada uno.

**Qué cambió:**

- **"Tu configuración", en el nombre del header**, con dos pestañas: *Cuenta de Vertex* (lo de antes) y
  **Aprobación**, donde cada uno elige cuántos clips se generan antes de frenar en SUS proyectos: 1 a 50,
  o 0 = sin límite (con aviso). "Volver al default" lo borra y rige el del `.env`.
- **La cola lo lee del dueño del proyecto** (`loteDeAprobacion`, `src/lib/preferencias.ts`), tanto para
  frenar como para el aviso "Lote de N clips listo… (de a N)". Se guarda en `DATA_DIR/preferencias.json`.
  Las imágenes siguen con el global (0: se generan todas y se revisan en bloque).
- **Guardar no arranca nada:** un proyecto ya frenado toma el número nuevo cuando se aprueba un clip o se
  reanuda. Si guardar bombeara la cola, subir el número arrancaría clips de golpe sin que nadie apriete
  Generar.
- El diálogo de la cuenta pasó a ser una pestaña (`CuentaVertexDialog` → `CuentaVertexPanel`, adentro de
  `ConfiguracionDialog`).

**Verificado en mock**, con aprobación manual y dos usuarios: Lucho con lote 2 frenó con 2 clips esperando
aprobación (aviso "de a 2") y al aprobarlos siguió con 2 más; Ivan, con el default, generó sus 5 sin
frenar. La API rechaza 51, -1, 2.5 y texto, y `null` vuelve al default. La pestaña en Chrome: carga el
valor, guarda con Enter, avisa con 0, y "Volver al default". `_verificacion-endpoints.sh` (con las líneas
de `CuentaVertexPanel` y `AprobacionPanel`), `_verificacion-aislamiento.sh` y typecheck en verde.

---

## 2026-09-26 (2) — `deploy.sh` ya no le pasa las variables de la app a PM2

**El problema:** el paso 3 de `deploy.sh` hace `source` del `.env.production` (para los guards) y después
`pm2 reload --update-env` desde ese mismo shell, así que PM2 guardaba todas las variables de la app en el
proceso. PM2 las **fusiona** con las que ya tenía: una variable borrada del `.env.production` seguía viva en
el proceso, y como `process.env` le gana al `.env` que lee Next, la app la seguía usando. Apareció al
apagar la cuenta de Vertex compartida en producción: con `GOOGLE_CLOUD_PROJECT` comentada, Ivan seguía
generando con ella. Con `PASSWORD_<NOMBRE>` era peor: **borrarla para sacarle el acceso a alguien no lo
sacaba**. Y `pm2 save` dejaba los secretos escritos en `~/.pm2/dump.pm2`.

**Qué cambió:** `deploy.sh` llama a PM2 con `env -i` (solo `HOME` y `PATH`); las variables las lee Next del
`.env.production` del standalone, como ya decía `ecosystem.config.js`. En producción se hizo una vez
`pm2 delete` + `pm2 start` limpio + `pm2 save` para sacar las que habían quedado guardadas.

**Verificado en producción:** después del reinicio limpio, `pm2 env` muestra solo `NODE_ENV`, `PORT` y
`HOSTNAME`; Lucho y Nahuel ven su cuenta y la prueba contra Google da OK; Ivan ve "Sin cuenta".

---

## 2026-09-26 — Una cuenta de Vertex por usuario, que cada uno carga desde la app

**El problema:** todos generaban con la misma cuenta de Google Cloud (`GOOGLE_CLOUD_PROJECT` + un solo
`adc.json`), así que las imágenes y los videos de cada uno se facturaban juntos y gastaban la misma cuota.
No había forma de separar quién pagaba qué, y cambiarlo pedía entrar al server.

**Qué cambió:**

- **"Tu cuenta de Vertex", en el nombre del header.** El nombre es ahora un botón con color (verde = cuenta
  propia, ámbar = la compartida, rojo = ninguna) que abre un diálogo: con qué cuenta generás hoy, cargar
  (o reemplazar, o quitar) el JSON de la tuya, y un **tutorial paso a paso** para sacarlo en la consola de
  Google, con links a cada pantalla.
- **"Probar y guardar" prueba antes de guardar, sin gastar** (token + `countTokens`, que es gratis). Si
  falta la facturación, la Vertex AI API o el permiso, o si la llave está mal, dice cuál con el link a
  donde se arregla, y no guarda nada: una cuenta rota guardada dejaba los jobs en rojo sin explicación.
  *Probar conexión* prueba la que se usa hoy.
- **La llave queda solo en el server** (`DATA_DIR/cuentas-vertex/`, carpeta 700, archivos 600, afuera de lo
  que sirve `/api/files`) y ninguna respuesta la devuelve, ni su path. Se aceptan solo `service_account` y
  `authorized_user`, reescritos con los campos necesarios: un `external_account` le puede hacer leer un
  archivo al server, correr un ejecutable o pegarle a una URL, y eso no puede entrar por un upload.
- **El ID de proyecto se valida** (va adentro del path de la URL de Vertex) y se completa solo con el
  `project_id` del JSON.
- **Orden de resolución** (`vertexCuentaFor`, `src/lib/cuentaVertex.ts`): la cargada desde la app, después
  `GOOGLE_CLOUD_PROJECT_<NOMBRE>` / `GOOGLE_APPLICATION_CREDENTIALS_<NOMBRE>` del `.env` (la alternativa del
  admin, mismo patrón que `PASSWORD_<NOMBRE>`), y por último la compartida. Sin tocar nada, todo sigue igual.
- **Los jobs usan la cuenta del dueño del proyecto** (`project.owner`): la cola corre sin sesión.
  `/api/parse` usa la de quien está logueado. `usuario` es **obligatorio** en las interfaces de los
  proveedores: un camino nuevo que se olvide de pasarlo no compila, en vez de generar con la compartida.
- **JSON propio del `.env` sin proyecto propio corta** y no cae al compartido: las credenciales de uno
  generarían en el proyecto del otro y la factura le llegaría a quien no generó nada, sin error.
- **La ventana de "N videos por minuto" es por cuenta** (clave: el proyecto de GCP), porque la cuota de Veo
  es por proyecto. Con la ventana global, los videos de uno frenaban los del otro.
- **El polling de Veo y la descarga de GCS usan la misma cuenta que lanzó la operación.**
- **`deploy.sh` (guard 3d) chequea cada usuario:** reconoce la cuenta cargada desde la app, corta si algo
  del `.env` está mal (JSON ilegible, JSON propio sin proyecto) y solo **avisa** si alguien no tiene
  ninguna: el usuario nuevo tiene que poder entrar para cargar la suya.
- `/api/config` devuelve el proyecto de quien pregunta (`project` + `cuentaPropia`).

**Verificado:** 12 combinaciones de vars del `.env` dan la cuenta esperada; 30 chequeos de la API con la
app levantada (validaciones, llave falsa rechazada por Google y no guardada, proyecto sin facturación con
su link, cuenta real guardada con permisos 600/700 y solo los campos de la lista, *Probar conexión* por el
mismo camino que un job, cada usuario ve solo la suya, reemplazar borra la llave vieja, quitar vuelve a la
compartida); una llave con `token_uri` a otro dominio igual va a Google; el guard 3d en 18 casos; en mock
con dos usuarios y 1 video por minuto, con una cuenta cada uno los primeros videos arrancan juntos (0,4 s)
y con la misma cuenta el segundo espera turno; el diálogo en Chrome (estado compartida, error de llave,
cuenta propia, probar, quitar con confirmación). `_verificacion-aislamiento.sh` (AISLAMIENTO COMPLETO,
31/0/0), `_verificacion-endpoints.sh` (SIN REGRESIONES, con la línea nueva del diálogo) y
`_verificacion-inventario.sh`. **No verificado:** el diálogo a ancho de teléfono (la ventana de Chrome no
se dejó achicar).

---

## 2026-09-25 (2) — Cambio de voz (ElevenLabs Voice Changer) y "Volver a unir"

**El problema:** Veo genera el audio clip por clip, cada uno como una generación independiente: la
misma persona suena distinta de un clip a otro y el timbre no se elige. Y una vez unido el video, la
pantalla Resultado no ofrecía volver a unir: si se regeneraba un clip, el unido quedaba viejo sin forma
de rehacerlo desde la interfaz.

**Qué cambió** (diseño y contratos en `tasks/cambio-de-voz/`):

- **Resultado → "Cambiar voz":** elige una voz (favoritas de la app, las de la cuenta de ElevenLabs o
  las predeterminadas), "Probar 20 s" antes de gastar, y genera un `.mp4` nuevo en `voz/` con todo el
  diálogo en esa voz. El original no se pisa; las versiones se ven, se bajan con nombre legible y se
  borran. Entran al zip (las pruebas no).
- **El video no se re-encodea** (`-c:v copy`, md5 idéntico) y la pista nueva tiene **exactamente** las
  mismas muestras que la original: cortes por muestra a 48 kHz y cada salida normalizada a su largo.
  Sin eso, 20 ms de error por tramo se acumulan y el final queda corrido de la boca.
- **Los clips sin diálogo y los `FILMAR_REAL` conservan su audio** (los filmados se pueden incluir).
- **El stitch guarda la receta del unido** (`ProjectRecord.recetaUnido`): qué clips entraron, dónde
  cae cada uno y su huella. Con eso Resultado detecta si un clip cambió después de unir, avisa cuál y
  bloquea el cambio de voz hasta **"Volver a unir"**, que es el botón nuevo. Un unido de antes de este
  cambio pide volver a unir una vez: reconstruir la receta a ojo daría números plausibles con el audio
  pegado sobre otro video, sin un solo error.
- **Asíncrono, una conversión a la vez en toda la app**, con cola propia en memoria (no la de Vertex).
  El POST contesta 202 al instante: esperar el resultado se comería el corte de 100 s de Cloudflare.
  Un reinicio marca la conversión fallida y no la retoma sola (retomarla gasta créditos).
- **Volver a unir con una conversión viva → 409**, y **borrar el proyecto cancela la conversión antes
  de borrar la carpeta** (si no, la corrida la recreaba con `mkdir -p` y quedaba un proyecto fantasma).
- "Unir en un video" ahora distingue el 524 de Cloudflare ("el servidor sigue uniendo, recargá en unos
  minutos") en vez de decir "No se pudo unir." con el stitch todavía corriendo.
- **La API key vive solo en el server** (`ELEVENLABS_API_KEY`, o una por usuario), y `deploy.sh` aborta
  (guard 3f) si `VOICE_PROVIDER=elevenlabs` y no hay ninguna. Default `VOICE_PROVIDER=mock`: no gasta.

**Medido antes de escribir el motor (T00, ElevenLabs real con audio de Veo):** la salida dura 15-22 ms
más que la entrada en 20, 60 y 270 s (0,01-0,08 %), sin corrimiento fijo; un tramo de 270 s tarda 56 s;
`wav_44100` pide plan Pro. **Verificado:** `_verificacion-voz.sh` (48 verde, FALLO 0),
`_verificacion-voz-mock.mjs` con 14 casos de punta a punta (`VOZ OK (mock)`) y
`_verificacion-ui-funcional.mjs` con Resultado incluido (`UI OK`).

De paso: el README y el steering todavía decían que los proyectos no estaban aislados por usuario. Lo
están desde `e66bd83`; se corrigieron los dos.

---

## 2026-09-25 — Cargar el avatar ANTES del brief, para que la IA no invente la cara

**El problema:** la tarjeta de avatares vivía dentro de la sección Plan, que recién aparece cuando ya
hay un plan. O sea: el avatar se subía después de interpretar, el interpretador nunca se enteraba y el
PlanJSON salía con el protagonista generado con text2image y descripto físicamente. La foto quedaba
"sin usar". Lo mismo con el prompt copiable para ChatGPT/Gemini: no llevaba los avatares.

**Qué cambió:**

- `NuevoProyectoWizard`: nueva sección **Avatares** entre Modelos y Brief (la tarjeta de antes, movida
  y con botón "Cargar avatar"). Si hay plan y un avatar no figura en él, avisa que hay que volver a
  interpretar.
- `prompts.ts`: el interpretador ahora trata al avatar como EL personaje del brief (por nombre, o el
  protagonista si hay uno solo), no crea otro asset para él y **no describe sus rasgos físicos**: sólo
  encuadre, pose, acción, vestuario, set y luz. `buildStoryboardPrompt()` mete los avatares cargados en
  el prompt copiable.
- `/api/parse`: seguro por si el modelo igual arranca al avatar con text2image (se fuerza image2image
  desde la foto, con warning) y warning si ningún plano usa un avatar subido.

---

## 2026-09-23 (3) — Auditoría de UI en pantalla chica y normal: 3 defectos, ninguno de layout

Auditoría pedida sobre el rediseño ya deployado. 10 pantallas x 4 tamaños (1680x1000, 1440x900,
1280x720, 1152x670) con Chrome por CDP, sembrando los 8 casos reales: video corto con video final
unido por ffmpeg, VSL de 5 clips en modo manual, VSL de 24 clips, dos tandas de imágenes y una tanda
masiva de 3 proyectos con prompt dual.

**Lo que está sano, y ahora está medido:** 0 elementos desbordando sin scroll, 0 cajas superpuestas, 0
scroll horizontal y 0 errores de consola en las 40 combinaciones. El bug de superposición del
2026-09-23 no volvió.

**Los tres defectos, todos de interacción y no de layout:**

1. **La manija de resize del panel de clip no se podía agarrar.** El `<aside>` tenía `overflow-y-auto`,
   lo que fuerza `overflow-x: auto`, y eso recorta lo que se sale de la caja. La manija está en
   `-left-1` (4px por fuera, para no robarle ancho al contenido) y esos 4px quedaban cortados: de los
   8px de agarre respondían 3, y justo sobre el borde `elementFromPoint` devolvía el aside. El scroll
   pasó al div de adentro. **Es una trampa que vale recordar: `overflow-y: auto` nunca es sólo
   vertical.**
2. **La tecla `A` no aprobaba en modo imágenes**, sí en clips. Misma pantalla, se cambia con el
   segmented: el mismo teclado hacía dos cosas distintas según el modo.
3. **La tira de pastillas repetía números entre proyectos** (el número es el `orden` dentro de cada
   proyecto), sin forma de ver de un vistazo dónde termina uno. Ahora hay un separador.

Y el botón de refrescar tandas en `/imagenes` tenía 14x14 de área clickeable, siendo de sólo icono.
Pasó a 24x24 (WCAG 2.5.8).

**Lo verificado funcionando, con clicks reales en 1440x900 y 1280x720 (21 casos, todos en verde):**
aprobar un clip, elegir variante, guardar diálogo y confirmar que **queda en el plan** (que es de donde
lee el export), resize con sus cuatro comportamientos, atajos de teclado, wizard de 3 pasos con su
validación, armar tablero desde la home, quitar del tablero, descargas (zip devuelve 200
`application/zip`), stitch con ffmpeg real y el segmented de revisión.

Queda una observación de diseño sin resolver: el máximo del panel de clip es `innerWidth - 360` (lo
pide el handoff), así que en 1280px el panel puede llegar a 920px y dejar la lista de clips en 360px,
que es poco para sus 6 columnas. No es un defecto, es el contrato; si molesta, el número a mover es ese.

---

## 2026-09-23 (2) — Volvieron "Aprobar clip" y "Extender +7s", que el rediseño había desconectado

**Qué pasó:** reporte de "me desapareció el botón de aprobar clip". Real, y venía con un segundo caso
más silencioso al lado.

El rediseño reemplazó las `JobCard` de video por lista + editor de clip. Los botones vivían en
`JobCard`, y el editor nuevo nunca los recibió: `onApprove` y `onExtend` se seguían creando en la
página y metiendo en el objeto `handlers`, pero `handlers` llega **sólo a las tarjetas de imagen**.

| acción | qué quedó | consecuencia |
|---|---|---|
| aprobar un clip | sin ningún botón | en modo manual el único camino era "Aprobar todos" del aviso, que compromete el lote entero — y cada clip de Veo son varios USD |
| extender +7s | sin ningún botón **en toda la app** | `extendJob` seguía en el store, `POST /api/jobs/:id/extend` seguía respondiendo y el README seguía documentando la función |

Los dos botones vuelven al editor con la **misma condición que usaba `JobCard`**: aprobar sólo si el
job está en `awaiting_approval`, extender sólo si el video ya tiene archivo.

**Lo que más importa de esto no es el botón, es que ningún control lo detectó.** Falló cada uno por un
motivo distinto:

- `_verificacion-endpoints.sh` compara **prefijos** (`/api/jobs/`), y el pipeline seguía mencionando ese
  prefijo por el preview del job. Dijo "SIN REGRESIONES".
- el typecheck: `extendJob` estaba importado, tipado y asignado a un `useCallback`. Código muerto
  impecable.
- el build y el inventario: ni se enteran.

Se agregaron dos verificaciones. `_verificacion-acciones-alcanzables.sh` parte de los endpoints que
existen y exige que cada uno se mencione en la interfaz; encontró dos huérfanos **preexistentes**
(`/api/files`, legítimo, y `/api/projects/[id]/stage`, sin llamadores desde `6069ed6` porque la fase se
cambia por `POST /api/batch`), los dos anotados como excepción con el motivo. Y
`_verificacion-ui-funcional.mjs`, que **abre la app de verdad** con Chrome por CDP y verifica que los
botones críticos estén en el DOM, además del chequeo de layout. Ese es el único que caza esta clase de
bug: el estático siguió diciendo OK cuando se simuló la pérdida, porque el endpoint estaba mencionado y
lo que lo cortaba era la condición de render.

**Verificado** clickeando el botón de verdad en la app: el clip pasó de `awaiting_approval` a `done`, el
log registró 'Video "c1" aprobado', el aviso bajó de 3 a 2 clips y la barra de Videos pasó a 1/3.

---

## 2026-09-23 — El pipeline se rompía en una laptop: las imágenes tapaban el log

**Qué pasó:** reporte de "en mi laptop se ve mal, se superponen cosas y queda horrible" en la pantalla
de un proyecto de video. Reproducido y medido con Chrome headless por CDP contra la app en mock, a
1440x820, 1366x660, 1280x700, 1152x656 y 960x600 (los dos últimos equivalen a zoom 125% y 150%).

El rediseño dejó **tres bloques `flex-none` compitiendo por el alto** dentro del shell de alto fijo de
`/project/[id]/pipeline`. A 1280x700 el reparto era:

| bloque | alto | flex |
|---|---|---|
| header + etapas + aviso | 161px | `flex-none` |
| imágenes + clips | 177px | `flex-1` |
| `LogPanel` | 305px | `flex-none` (43% del viewport) |

La sección de imágenes mide ~900px de contenido y es `flex-none`: no se encoge. Su contenedor no tenía
overflow, así que se salía 756px y **se dibujaba encima del log**. En pantalla: las tarjetas de imagen
tapaban las líneas del log y los botones "Regenerar/Editar" quedaban flotando cortados abajo. Y el grid
de clips, que es el contenido de la pantalla, se quedaba con 177px: invisible.

**La regla que se violó** es la que este mismo CHANGELOG anotó el 2026-09-22: en un shell de alto fijo,
todo lo que puede crecer sin techo tiene que vivir adentro de algo que scrollee. Un `flex-none` con
cientos de px de contenido no es una excepción, es el caso exacto que rompe.

Lo que se cambió:

- La sección de imágenes y el log viajan **adentro** del scroll de la columna de clips (props
  `encabezado` y `pie` de `PipelineClips`). Arriba queda un solo `flex-none`: el header.
- La sección de imágenes arranca **colapsada siempre**. Antes se abría sola con pocos jobs y se comía
  el primer scroll entero, así que la lista de clips no se veía sin scrollear. Se borró
  `UMBRAL_VISTA_LIVIANA`: era el número que elegía a partir de cuántas imágenes empezaba a molestar, y
  medido molesta desde la primera.
- La grilla de tarjetas de imagen pasa de breakpoints de Tailwind a `auto-fill minmax(200px,1fr)`.
  **Los breakpoints miden el viewport, no el contenedor**, y esa grilla vive en una columna de 710px
  porque el editor de clip se lleva el resto: `lg:grid-cols-4` + `xl:grid-cols-6` pedía 4 columnas en
  743px y daba tarjetas de 130px con el id truncado a "ava…". Es un error que va a volver a aparecer en
  cualquier grilla que se ponga dentro de una columna angosta.
- En Resultado, las miniaturas de 72px dejan de ser `<video controls>`: en ese ancho el navegador
  colapsa la barra de controles al menú de ⋮ y la tarjeta quedaba con tres puntitos y una barra de
  progreso encima del video. Ahora son un link al archivo con un ícono de play, y de paso no montan un
  elemento de medios por cada uno de los 95 clips de un VSL.
- En `/imagenes`, el centro decía "Todavía no generaste nada" **mientras el sidebar listaba las
  tandas**: dos afirmaciones contradictorias en la misma pantalla. Ahora hay dos vacíos distintos y, si
  hay tandas y ninguna abierta, se abre la primera sola.

**Verificado:** 7 pantallas x 5 tamaños = 35 combinaciones con 0 elementos desbordando sin scroll y 0
cajas superpuestas (antes: 12 elementos desbordando en el pipeline, hasta +756px). Incluye un VSL de 24
clips en modo manual, que es el caso con el header más alto (221px, porque suma el aviso de
aprobación). Más `tsc`, `build` 10/10, endpoints SIN REGRESIONES, inventario COMPLETO y cn/contraste en
0 fallos. Esta vez sí hubo revisión visual: 14 capturas a tamaño de laptop.

---

## 2026-09-22 — Rediseño de las cuatro pantallas: el scroll sale de la página

**Qué pasó:** las pantallas de trabajo (galería de imágenes, pipeline de un proyecto, revisar) son
pantallas donde se mira contenido en 9:16 y se decide sobre él, y estaban armadas como documentos:
la página scrolleaba, el contenido crecía para abajo y los medios se dimensionaban contra el ancho.
Consecuencias medidas: para elegir una variante de una tanda había que scrollear hasta el final y
volver a subir; el video de un clip quedaba de 162px de ancho, del tamaño de un sello, justo en la
pantalla donde hay que decidir si sirve o se regenera; y el grafo del pipeline pedía ~2700px de
scroll con un VSL de 95 clips para decir lo que tres barras de progreso dicen en un segundo.

Se implementó el handoff `design_handoff_rediseno_augc` en cuatro partes. **Ningún endpoint, payload
ni regla de negocio cambió**: es layout y presentación. Se mantienen el polling con ref, `editando`
separado de `prompts`, el gate por lotes, los ids del lote en la URL, el orden FIFO de la cola y que
el export a ffmpeg lee del plan.

**La decisión de fondo:** `layout.tsx` pasa a ser un shell de alto fijo (`h-screen flex flex-col
overflow-hidden`, header de 56px, `main` en `flex-1 min-h-0` sin max-width ni padding). El scroll
vive adentro de cada columna y los medios se dimensionan con container queries contra el alto REAL
disponible. De ahí sale la utilidad `.cq-size` de `globals.css`: va a mano porque el plugin de
container queries de Tailwind 3.4 solo genera `inline-size`, que deja `100cqh` sin resolver y la
imagen desborda el contenedor.

**Consecuencia para quien agregue una pantalla:** el body es `overflow-hidden`, así que una página
que no use `PantallaScroll` ni `PantallaFija` (`src/components/Pantalla.tsx`) y mida más que el
viewport queda CORTADA, sin ningún error.

Lo que cambió por pantalla:

- **`/imagenes`** — grid `272px | 1fr` a alto completo: sidebar con las tandas y las N variantes en
  una fila al alto disponible. "Nueva tanda" y el generador masivo pasan a ser pantallas propias en
  vez de formularios siempre visibles. Lightbox, hilo de pastillas `v1 -> v2` armado desde
  `ref_image_id`, chat de cambios fijo abajo y navegación con teclado.
- **`/project/[id]`** — `FlowGraph` se reemplaza por `Etapas` (una fila de cards con `a/b` y barra de
  4px). El pipeline es timeline grande + lista de clips con scroll propio + editor de clip en un
  panel **redimensionable** (mínimo 320px, máximo `innerWidth - 360`, ancho en localStorage). En
  Resultado el video final ocupa el alto disponible y lo que scrollea es la columna de al lado.
- **`/`** — cards de proyecto con mini-timeline de clips, dos barras de progreso y CTA cuando algo te
  espera; el formulario de nuevo proyecto pasa a wizard de 3 pasos con footer fijo.
- **`/batch`** — dos cards de totales más tabla de proyectos; y las dos pantallas de revisión
  (`/batch/review` y `/batch/videos`) se unifican en un solo componente con segmented Imágenes/Clips
  y el modo en `?modo=img|vid`. Las dos rutas siguen existiendo y montan el mismo componente: hacerlo
  con un redirect entre rutas remontaba el árbol y se perdían `lockRef`, `resolved`/`skipped` y los
  candados de doble acción.

**Un fetch nuevo, de lectura:** la home agrega `GET /api/batch?ids=`. El endpoint ya existía y no
dispara ninguna acción, pero hace falta porque las cards muestran el mini-timeline, las barras de
progreso y "N clips esperan tu aprobación", y `GET /api/projects` devuelve solo id, nombre, estado,
fechas y los conteos del plan. Es best-effort: si falla, la card cae a su versión básica.

**Archivos borrados por quedar sin un solo import:** `src/components/ProjectTabs.tsx` (lo reemplaza
el segmented del header), `src/components/FlowGraph.tsx` (lo reemplaza `Etapas`) y
`src/app/batch/ClipTimeline.tsx` (lo reemplaza `MiniTimeline`, que además pasa el ancho del bloque de
px fijos a `flex-grow = duracionSeg`: con 95 clips la tira vieja medía 3040px y aparecía scroll
horizontal). Ninguna funcionalidad se fue; los tres tienen reemplazo.

`tasks/_verificacion-endpoints.sh` se actualizó porque el rediseño movió fetch a propósito (los dos
decks a `ReviewBoard`, la home partida en `HomeProyectos` + `NuevoProyectoWizard`). Cada movimiento
está explicado en el encabezado de la `LINEA_BASE`.

**Verificado:** `npx tsc --noEmit` sin errores, `npm run build` compila las 10 páginas sin warnings,
`_verificacion-endpoints.sh` SIN REGRESIONES, `_verificacion-cn.mjs` y `_verificacion-contraste.mjs`
con 0 fallos, y una auditoría de que no se colara ni un color literal (ni `#hex` ni `zinc-700`) en el
código nuevo. **Falta la prueba visual en el navegador**, que no se pudo hacer en esta sesión.

---

## 2026-09-21 — El tablero (/batch) arranca los proyectos de a UNO, no todos juntos

**Qué pasó:** con un tablero grande (30 proyectos en el reporte que motivó esto), "Comenzar
imágenes"/"Comenzar videos" encolaba los N proyectos de una con `enqueueProject()` en un loop. La
concurrencia de la cola es global (`PIPELINE_CONCURRENCY`, default 3) pero eso no limita cuántos
jobs quedan "pending" disponibles para llenar esos slots: apenas termina un job de un proyecto, la
cola toma el de OTRO proyecto para el slot libre, así que 30 proyectos sostienen 3 requests
simultáneas contra el mismo modelo sin pausa. Resultado: 429 en cascada, se agota el presupuesto de
10 reintentos de rate limit (aparte de los intentos normales) y los jobs quedan `failed` en vez de
esperar su turno — los 30 proyectos del reporte fallaron todos.

El generador masivo (`/imagenes`, pestaña "Generador masivo") ya resolvía exactamente este problema
corriendo un proyecto a la vez (`startBatch`/`notifyProjectFinished`, `src/lib/jobs/masivo.ts`). Se
reusa el mismo mecanismo para `/api/batch` en vez de inventar uno nuevo:

- `POST /api/batch` (`start-images`/`start-videos`) ya no llama `enqueueProject` por cada proyecto:
  arma el plan/jobs de todos primero y llama `startBatch()` una sola vez con el orden de los ids.
  `startBatch` encola solo el primero; el resto queda esperando su turno.
- `notifyProjectFinished` (el hook que encola "el siguiente") antes solo se llamaba cuando un
  proyecto llegaba a un status terminal (`done`/`partial`/`failed`) — que es lo único que pasa en el
  generador masivo, porque fuerza `autoApprove: true`. El tablero, en cambio, arranca en modo manual
  por default (`autoApprove: false`): un proyecto ahí NUNCA llega solo a un estado terminal, se frena
  en `review`/`awaiting_approval` esperando que el usuario apruebe. Sin más cambios, el batch
  secuencial habría arrancado el proyecto 1 y dejado los 29 restantes esperando para siempre. Se
  agregó el mismo llamado a `notifyProjectFinished` también en la rama de `finalizeProjects` donde el
  proyecto se desactiva por quedar todo `awaiting_approval` sin nada más que pueda generarse solo:
  "ya no le va a pedir más nada a la cola" es la señal correcta para dejar pasar al siguiente, sea
  que terminó de verdad o que está esperando revisión humana (que puede pasar en paralelo mientras el
  siguiente proyecto genera).
- El guard existente de `notifyProjectFinished` (`idx !== batch.cursor`) ya cubre las llamadas
  repetidas para el mismo proyecto sin trabajo adicional: un proyecto de video con gate por lotes
  (`PIPELINE_APPROVAL_BATCH_VIDEOS`) puede caer en esa rama varias veces a medida que se aprueban
  lotes de 5; solo la primera vez avanza el cursor.
- Archivos: `src/app/api/batch/route.ts`, `src/lib/jobs/queue.ts`,
  `src/app/batch/BatchBoard.tsx` (texto del tooltip de "Comenzar imágenes", desactualizado con el
  comportamiento nuevo).
- **No verificado con build/typecheck** (steering del proyecto: no correr salvo pedido explícito).
  Verificado por lectura del flujo completo (`queue.ts`, `masivo.ts`, `batch/route.ts`,
  `imagenes/masivo/route.ts`) y confirmando que no hay otro punto del código que encole varios
  proyectos en loop (`grep` de `enqueueProject` en todo `src/`).

---

## 2026-09-20 (3) — "Prompt dual": los dos prompts vienen precargados como referencia editable

**Qué pasó:** los textareas de Prompt A / Prompt B del switch "Prompt dual" arrancaban vacíos con
solo un placeholder gris de ejemplo. Ahora, la primera vez que se activa el switch, se precargan con
un prompt de referencia REAL y editable — no un placeholder que desaparece al tipear, texto de
verdad que se puede dejar tal cual o modificar. `PROMPT_A_DEFAULT` es (casi textual) el prompt que
ya se usa en producción para la variación conservadora; `PROMPT_B_DEFAULT` es la contraparte de
libertad creativa pensada para el mismo caso.

- **No son obligatorios**: `toggleDual()` solo precarga si el campo está VACÍO (`actual || default`).
  Si el usuario ya escribió algo y apaga/prende el switch, lo suyo no se pisa.
- **Botón "Restaurar el sugerido"** debajo de cada textarea, visible solo cuando el contenido se
  desvió del default — para volver atrás sin borrar todo a mano.
- Verificado: `tsc --noEmit` sin errores. Smoke test HTTP de `/imagenes` en modo mock (200, sin
  errores de render).

---

## 2026-09-20 (2) — Generador masivo: switch "Prompt dual" (2 prompts × 2 modelos, 4 variantes fijas)

**Qué pasó:** el generador masivo (ver la entrada de más abajo) generaba las N variantes de una foto
con un solo prompt y el modelo del proyecto. El pedido: poder probar **dos prompts** por foto — uno
conservador ("variación casi igual, no cambies mucho") y otro con libertad creativa ("usá esta foto
de referencia y armá el ad") — cruzados con los dos modelos, en vez de 4 variantes idénticas del
mismo prompt/modelo. Mapeo fijo, sin opción de elegir otro:

```
v1 = prompt A + Flash     v2 = prompt B + Flash
v3 = prompt A + Pro       v4 = prompt B + Pro
```

Esto tocó una asunción de fondo del pipeline de imagen: `runImageGeneration` asumía que **todas**
las variantes de un job comparten el mismo prompt y el mismo modelo (solo cambiaba el request, no
sus parámetros). Se cambió eso puntualmente, de forma aditiva:

- **`Candidate` (types.ts)** gana `model?` y `promptLabel?` — qué modelo/prompt generó ESA variante
  puntual. Quedan `undefined` (no se serializan) fuera del modo dual: en el caso normal las 4
  variantes comparten prompt/modelo (ya expuesto en `JobRecord.model`), así que no hay nada nuevo
  que mostrar y no se duplica información.
- **`VariantPlanEntry` (types.ts, nuevo tipo)** — contrato de `job.meta.variantPlan`: un array
  `{prompt, model, label?}[]` 1-based, por índice de variante. Vive en `meta` (no como campo propio
  de `JobRecord`) porque es un caso de uso específico de una sola pantalla.
- **`runImageGeneration` (jobs/pipeline.ts)** — si `job.meta.variantPlan` está presente (validado en
  runtime: una forma que no calza se descarta en silencio y esa variante cae al comportamiento de
  siempre, nunca revienta el job por esto), cada variante `i` usa `planParaVariante(i)` en vez de
  `img.prompt` / `model` fijos. El resto de la función es exactamente el mismo camino: una request
  por variante, pausa entre ellas, reintentos con backoff ante 429, persistencia incremental. Los
  tres puntos donde se guardaba `model` a nivel de job se ajustaron para reflejar el modelo de la
  variante correspondiente en vez de un valor que, con plan dual, ya no describe al job entero.
- **`POST /api/imagenes/masivo`** — nuevo flag `dual` (string "true"/"false", FormData no tiene
  booleanos) + `promptA`/`promptB` en vez de `prompt`. Con `dual=true` se fuerza `variantes: 4`
  **en el backend** (no solo deshabilitado en la UI: un cliente que mande otra cosa no se puede
  saltar la regla), el plan del proyecto usa `promptA` como "el prompt" de siempre (se ve así en
  manifest/UI), y tras `buildJobs` se le escribe `meta.variantPlan` al job de imagen recién creado.
- **UI (`GeneradorMasivo.tsx`)** — switch "Prompt dual" (mismo patrón que el de auto-aprobación de
  la home): activado, cambia el formulario a dos textareas (Prompt A / Prompt B) y deja el selector
  de variantes deshabilitado mostrando "4" fijo. **`ImagenesBoard.tsx`** (donde se revisan las 4
  variantes) muestra un badge nuevo en la esquina inferior izquierda de cada miniatura ("A · Flash",
  "B · Pro"...) cuando `candidates[].promptLabel` viene poblado — invisible en el caso normal.
- **Verificado**: `tsc --noEmit` sin errores. Probado en modo mock con 1 foto: `GET
  /api/projects/:id/jobs` confirma `candidates[0..3]` con exactamente `{A,Flash}, {B,Flash}, {A,Pro},
  {B,Pro}` en ese orden, y `pipeline.log` confirma los mismos prompts/modelos en cada request real
  (con la pausa entre variantes intacta). Validado que `dual=true` sin `promptB` da 400 con mensaje
  claro. Confirmado que el modo normal (`dual=false`) no cambió: mismos candidatos sin
  `model`/`promptLabel` (ausentes del JSON, no `null`). `tasks/_verificacion-endpoints.sh` →
  `SIN REGRESIONES`.

---

## 2026-09-20 — `/imagenes`: generador masivo de variaciones (N fotos + 1 prompt, secuencial)

**Qué pasó:** generar muchos creativos de golpe (subir 10 fotos, un prompt genérico tipo "hacé una
variación de este creativo, no cambies mucho") pegaba contra la cuota por minuto de un solo modelo
de imagen y terminaba en 429 en cascada — los jobs agotaban los `PIPELINE_RATE_LIMIT_MAX_ATTEMPTS`
(10) reintentos y quedaban `failed`. Nueva pestaña "Generador masivo" en `/imagenes` que resuelve
esto con dos mitigaciones, ninguna alcanza sola:

1. **Alterna modelo por proyecto**: par → `gemini-3-pro-image` (Nano Banana Pro), impar →
   `gemini-3.1-flash-image` (Flash). Dos proyectos corriendo cerca en el tiempo pegan contra cuotas
   *distintas*, así no se suman contra el mismo límite.
2. **Corre SECUENCIAL entre proyectos**, no en paralelo: el proyecto N+1 no se encola hasta que el N
   llega a un status terminal (`done`/`partial`/`failed`). Dentro de cada proyecto individual las
   variantes siguen corriendo en paralelo como siempre (eso no cambió); lo que se evita es que los
   N proyectos de la tanda arranquen todos juntos y multipliquen la carga por N.

No se creó un pipeline nuevo: cada foto se convierte en un proyecto de sólo-imágenes independiente
(mismo mecanismo que `/api/imagenes` con imagen base — `image2image` contra la foto subida), así que
reutiliza la cola, los reintentos, el rate limit y el auto-approve que ya existían.

- **`src/lib/jobs/masivo.ts` (nuevo)** — estado de tandas secuenciales en `globalThis` (mismo patrón
  que `queue.ts`, sobrevive al HMR). `startBatch(batchId, projectIds, enqueueProject)` encola sólo el
  primer proyecto; los demás quedan `draft` con sus jobs ya armados. `notifyProjectFinished(projectId,
  enqueueProject)` se llama desde `queue.ts` cada vez que un proyecto termina y, si es el que está al
  frente de una tanda activa, encola el siguiente. `enqueueProject` se **recibe como parámetro** en
  vez de importarse: `masivo.ts` no importa `queue.ts`, así evita el ciclo de import que se daría si
  lo hiciera (`queue.ts` ya necesita llamar a este módulo desde `finalizeProjects`).
- **`queue.ts`**: un solo hook nuevo, al final de `finalizeProjects()`, justo después de persistir el
  status terminal del proyecto — `notifyProjectFinished(projectId, enqueueProject)`. Para un proyecto
  que no pertenece a ninguna tanda (el 100% de los casos hasta ahora) es un lookup O(1) que no hace
  nada; no se tocó ninguna otra lógica de la cola (concurrencia, backoff, rate limit de video, gate
  por lotes siguen exactamente igual).
- **`POST /api/imagenes/masivo` (nuevo)** — multipart: N archivos (`fotos`, repetido) + `prompt` +
  `nombreBase` + `variantes`/`aspectRatio`/`imageSize`/`negativePrompt` opcionales. Crea los N
  `ProjectRecord` primero (si algo falla a mitad de camino, no queda una tanda mitad creada mitad
  corriendo) y recién después llama a `startBatch`. `autoApprove: true` a propósito — al revés que
  `/api/imagenes`, que lo fuerza a `false` porque su UI es para elegir variante a mano: acá el punto
  es no sentarse a aprobar cada una de N fotos, cada job pasa a `done` solo al terminar.
- **`ProjectRecord.batch?: { batchId, position, total }` (`types.ts`)** — persistido en el proyecto
  (no sólo en la memoria de `masivo.ts`) para que la UI pueda seguir agrupando visualmente los N
  proyectos de una corrida después de un reinicio, aunque la cola en memoria (y con ella, el
  autoavance secuencial) se pierda como el resto de la cola. Expuesto en `GET /api/projects`.
- **UI**: `/imagenes` pasa a tener dos pestañas (`ImagenesTabs.tsx`, Radix `Tabs` no controlado,
  `defaultValue` — a diferencia de `ProjectTabs` no sincroniza con la URL porque las dos pestañas
  viven en la misma ruta y no chocan con el `?id=` que ya usa `ImagenesBoard`). "Generar" es
  `ImagenesBoard` sin cambios. "Generador masivo" es `GeneradorMasivo.tsx` (nuevo): dropzone
  multi-archivo con drag&drop, un prompt único, nombre de tanda, variantes/formato/calidad, y la
  lista de tandas lanzadas en la sesión con el estado de cada proyecto (poll a `/api/projects`
  filtrando por `batch.batchId`, mismo patrón de polling con apagado automático que `ImagenesBoard`)
  y link a cada uno (`/imagenes?id=<id>`, se revisa en la pestaña "Generar" de siempre — esta
  pantalla no duplica la grilla de variantes).
- **Verificado**: `tsc --noEmit` sin errores. `tasks/_verificacion-endpoints.sh` →
  `SIN REGRESIONES` (no se tocó ningún fetch existente). Probado en modo mock con 3 fotos: los 3
  proyectos se crean (`alma-gemela 1/2/3`), alternan modelo (Pro/Flash/Pro) y el `pipeline.log`
  confirma que corren secuencial (el proyecto N+1 arranca milisegundos después de que el N se
  aprueba, nunca antes). Validado que sin fotos o sin prompt devuelve 400 con mensaje claro.
  `npm run lint` no tiene `eslint.config.*` en este repo (pide setup interactivo de Next 14); no se
  configuró, queda igual que antes de este cambio.

---

## 2026-09-19 — `/imagenes`: imagen base subida (image2image) y chat iterativo con historial

**Qué pasó:** `/imagenes` sólo podía generar desde cero (text2image) y "Variar" reemplazaba la
imagen existente sin dejar rastro de los pasos anteriores. Ahora se puede (1) arrancar subiendo una
foto propia como base, y (2) encadenar modificaciones sucesivas (v1 → v2 → v3...) viendo **todas**
las imágenes de la cadena, no solo la última.

No se tocó el schema del plan ni el pipeline: las dos piezas que hacían falta ya existían para el
caso VSL (`references[]` subidas + `image2image` con `ref_image_id` apuntando a otra `Image` del
proyecto). Este cambio expone ese mismo mecanismo desde la pantalla de imágenes sueltas.

- **`POST /api/imagenes` acepta multipart** (`src/app/api/imagenes/route.ts`). Si el body es
  `multipart/form-data` con un campo `imagenBase` (File), el archivo se guarda como `reference`
  (mismo camino que usan los avatares VSL) y la primera `Image` del plan nace `image2image` contra
  ella en vez de `text2image`. Sin archivo, sigue exactamente igual que antes (JSON). El
  Content-Type decide qué parser usar *antes* de leer el body (`req.json()` revienta con multipart).
- **`POST /api/projects/:id/images` (nuevo)** — agrega un turno de chat: crea una `Image` NUEVA
  (`image2image`, `ref_image_id = fromImageId`) en vez de editar la existente, para que cada paso
  quede visible y no se pierda al "variar". Exige que `fromImageId` esté aprobada (`status: done` +
  `outputPath`) antes de aceptar el turno — si no, `runImageGeneration` fallaría con un error menos
  claro más adelante en la cola. El id nuevo es `<base>_v<n>` (sin anidar sufijos si `fromImageId`
  ya era un turno). `buildJobs` detecta la dependencia sola (mismo código que ya usan las imágenes
  VSL encadenadas): no hay lógica de dependencias nueva.
- **`buildChatHistory` (`src/lib/imagenes.ts`)** — sigue `ref_image_id` hacia atrás desde una imagen
  hasta la raíz de la cadena, con tope de 200 iteraciones contra un plan con ciclos. La respuesta del
  endpoint nuevo la incluye (`history`) para que el cliente pueda verificar contra lo que ya armó
  solo con el manifest.
- **`ImagenesBoard.tsx`**: input de archivo opcional ("Imagen base") con preview; al enviar con
  archivo usa `FormData`, sin archivo sigue con JSON. Los resultados se agrupan por **hilo** (cadena
  completa de una imagen, siguiendo `ref_image_id` del manifest en el cliente) en vez de una grilla
  plana: cada hilo se ve como una fila v1 → v2 → v3 con un chat debajo, habilitado sólo cuando la
  última imagen de la cadena está aprobada.
- **Verificado sin build/typecheck** (prohibido correrlos salvo pedido explícito): lectura completa
  de los archivos tocados + `tasks/_verificacion-endpoints.sh` → `SIN REGRESIONES` (el fetch nuevo
  cae bajo el prefijo `/api/projects/` que la línea base ya esperaba) + `tasks/_verificacion-
  inventario.sh` → sin cambios en los archivos intocables (`pipeline.ts`, `queue.ts`, `schema.ts`,
  `storage.ts`, `db.ts`, etc.).

---

## 2026-09-08 — Aislamiento por usuario: implementado, migrado y deployado

**Qué pasó:** las 8 tasks del plan se ejecutaron completas. `owner?: string` en
`ProjectRecord`, el helper `src/lib/ownership.ts` (5 funciones: `sessionUser`,
`ownerOf`, `requireProjectOwner`, `requireJobOwner`, `filterOwnedIds`), guard de
dueño en las 21 rutas que recibían un projectId o jobId, y el cartel de `/batch`
dejó de decir "los borraste" (ahora es neutro: mezcla ajenos con inexistentes a
propósito, para no confirmar qué proyecto existe).

**La migración corrigió el supuesto inicial del plan.** Se creía que había ~12
proyectos; en producción había **29** (119 jobs, 22 logs). Los 4 nombres de Ivan
(`AA_rendicion_meresigne_duena52_v01/v02`, `AA_alquiler_marcodepuerta_duena31_v01`,
`AA_manerastontas_multivoz_v01`) coincidieron **exacto** contra la DB real — la
pregunta abierta P-01 del plan queda resuelta: sin typos, sin duplicados, los 4 son
de tipo `video` (no colisiona con "las imágenes van todas a Lucho", P-03 resuelta).
Migración: **4 a `ivan`, 25 a `lucho`**, 0 pérdidas (29→29 proyectos, 119→119 jobs,
22→22 logs, 29→29 carpetas en `output/`), idempotente (segunda corrida: "0
asignados, 29 ya tenían dueño"), con backup propio
(`db.json.bak-2026-09-08T20-53-24-950Z`) más uno manual.

**Deploy**: commit `e66bd83` en `main`, corrido con `deploy/deploy.sh` en el
server. `typecheck ok`, `build ok`, health check `/login → 200`, `api/config`
responde 401 (guard de auth activo). P-02 del plan queda resuelta: el deploy se
corrió vía el alias SSH `funnel-vps` (usuario `deploy`, sin sudo).

**Verificado en producción** (no solo local): sin cookie, `/api/files/<cualquier
id>/manifest.json` da 401 (el middleware ya bloquea antes de llegar al guard de
dueño). **Pendiente**: el QA completo de las 9 filas con las dos cuentas reales
(`ivan`/`lucho`) — no se corrió porque este proceso no tiene las passwords; queda
para confirmar a mano que cada uno ve solo lo suyo.

---



**Qué pasó:** el `README.md` y `.kiro/steering/project-context.md` describían un estado de junio
(app local, sin auth, sin deploy, modelos `gemini-2.5-*`). El código real ya tenía login por usuario,
infraestructura de deploy completa y el catálogo Gemini 3.x desde fines de agosto. Un asistente que
leía el steering arrancaba con supuestos falsos.

- **`README.md` reescrito contra el código.** Ahora documenta: login por usuario
  (`PASSWORD_<NOMBRE>` + cookie HMAC), las tres superficies de trabajo (`/`, `/imagenes`, `/batch`
  con sus tres vistas), el catálogo real de modelos, `GOOGLE_CLOUD_LOCATION=global` y por qué,
  el comportamiento completo de la cola, los **31 handlers HTTP en 25 archivos**, la tabla completa
  de variables de entorno, y el deploy real (`/srv/generador`, PM2 con una sola instancia, Caddy,
  los guards de `deploy.sh`).
- **`.kiro/steering/project-context.md` reescrito.** Mismo contenido en versión corta, más las
  pistas para no romper nada (una sola instancia de PM2, `DATA_DIR`/`OUTPUT_DIR` absolutos, el export
  lee del plan y no de los jobs).
- **`CHANGELOG.md` nuevo** (este archivo).
- **Limitación conocida documentada en los dos**: los proyectos **no** están aislados por usuario, y
  son cuatro caminos por los que se ve lo ajeno, no uno.

**Planificado, sin implementar todavía:** `tasks/aislamiento-por-usuario/` — 13 archivos, 8 tasks en
3 olas (T01 sola → T02-T07 en paralelo → T08 sola).

Decisiones de alcance tomadas con el usuario: campo `owner` en `ProjectRecord` + chequeo de dueño en
**21 rutas**, y **no** partir `db.json`/`output/` por usuario (los paths absolutos están grabados en
cada `ProjectRecord` y en cada `manifest.json`, y habría que mover archivos en producción para el
mismo resultado). Lo ajeno devuelve **404 y no 403**, para no confirmar que un proyecto existe. Sin
usuario administrador. La cola de jobs sigue compartida.

Migración de los ~12 proyectos existentes: todos a `lucho` menos cuatro, que son de `ivan`. El script
(`_migracion-owner.mjs`) hace backup, es idempotente, conserva los campos opcionales del proyecto, y
**aborta sin escribir** si no encuentra alguno de los 4 nombres — porque se transcribieron a mano y un
match silencioso le daría a Lucho un proyecto de Ivan. Verificado contra una base scratch: **7/7 en
verde**. Punto de partida del módulo medido: `verde 7 · pendiente 24 · fallo 0`.

Lo que **no** se pudo verificar y queda anotado como P-01 del plan: que esos 4 nombres coincidan
carácter por carácter con los de `db.json` en producción. En este checkout no existe `./data`, y no se
lee producción para averiguarlo.

---

## 2026-08-27 → 2026-08-29 — Producción: auth, deploy y rediseño de UI

La tanda que convirtió la app local en una herramienta desplegada.

- **Login por usuario** (`feat(auth)`): un usuario por `PASSWORD_<NOMBRE>`, cookie
  `gen_session` firmada con HMAC-SHA256, comparación timing-safe, rate limit por IP (5 cada 15 min),
  y **falla cerrado** — sin `AUTH_SECRET` o sin ninguna password no entra nadie. El middleware
  reimplementa el verify con Web Crypto porque corre en Edge.
  - `fix(login)`: la password **correcta** daba error del server. `router.push("/")` dentro de un
    `router.refresh()` caía en el `redirect("/")` de `/login` y Next lo reportaba como error de
    render. Se cambió por `window.location.assign("/")`.
- **Deploy en la VPS** (`chore(deploy)`): releases por timestamp, PM2 con **una sola instancia**
  (la cola vive en memoria), Caddy detrás de Cloudflare, swap atómico con `mv -T`, health check
  contra `/login` y rollback automático.
  - `fix(deploy)`: `npm ci --include=dev` es obligatorio. El guard hace `source` del
    `.env.production`, que setea `NODE_ENV=production`, y con eso `npm ci` saltea las
    devDependencies — donde vive `tsc`.
  - `chore(deploy)`: `deploy.sh` se re-ejecuta si el commit lo modificó. Bash lee el script por
    offset de bytes; si cambia de tamaño a mitad de ejecución, ejecuta líneas cortadas. Pasó.
- **Modelos a Gemini 3.x y `location=global`** (`feat(modelos)`): toda la familia 3.x da 404 en
  las regiones y sólo existe en `global`. Se agregó 3.7 Flash al selector (3.6 sigue de default: es
  más rápido y más parejo).
- **Pantalla de sólo imágenes** (`feat(imagenes)`): un prompt por proyecto con formato y calidad
  elegibles. Antes partía el texto por línea, lo que convertía un prompt de cinco líneas en cinco
  prompts cortados al medio.
- **Tablero de lotes** (`feat(batch)`): `/batch`, `/batch/review` (revisión FIFO tipo tinder) y
  `/batch/videos` (línea de tiempo de clips), más las fases `images`/`videos` para revisar todo
  antes de gastar en Veo.
- **Rediseño de UI en 12 tasks paralelizables** (`tasks/00-PLAN-REDISENO-UI.md`, T01-T12): tokens,
  tipografía Geist y 10 primitivas en `src/components/ui/`, y las 8 pantallas migradas encima.
- **Arreglos de cuota y cola**:
  - `fix(imagenes)`: pedir 2 variantes devolvía 1 **en silencio**. `gemini-3.1-flash-image` contesta
    429 a los ~200ms si se le manda la segunda pegada a la primera. De ahí salió
    `PIPELINE_IMAGE_VARIANT_GAP_MS` (2500ms).
  - `fix(cola)`: un reintento por 429 quedaba huérfano si otro job esperaba aprobación.
  - `fix(cola)`: los jobs que quedaron en `generating` tras un reinicio se retoman solos.
- **Stitch y descarga**:
  - `feat(stitch)`: el video unido se llama como el proyecto, no `final.mp4` — cinco proyectos
    bajaban cinco archivos con el mismo nombre.
  - `perf(stitch)`: preset `medium` en vez de `slow` (39% más rápido, misma imagen) y respetar el
    fps de los clips en vez de forzar 30.
  - `fix(download)`: la descarga en zip fallaba en la VPS porque `zip` no viene en Ubuntu Server.
    `deploy.sh` ahora avisa.

---

## 2026-05-31 → 2026-07-05 — El pipeline (PRs #1 a #26)

La construcción del núcleo, antes de que la app saliera a internet.

- **VSL con avatares de referencia** (#9, #10): fotos subidas como fuente de identidad. La primera
  imagen de cada persona es `image2image` contra la foto real; los planos siguientes mantienen la
  cara. Con validación cruzada en el schema para que una imagen no se referencie a sí misma.
- **Resiliencia del pipeline** (#11, #12, #13): manejo de 429 con backoff dedicado de 45s y
  presupuesto de reintentos propio, variantes con éxito parcial (cada éxito se persiste al toque),
  auto-aprobación con ventana de concurrencia, y destrabado de jobs colgados en `generando`.
- **Revisión y edición** (#14, #15, #16, #19): vista de revisión liviana, regeneración por lote,
  el prompt **exacto** que se ejecuta con la imagen de input y el JSON, prompts editables, y
  override del prompt final que se le manda a Veo por clip.
- **Auto-approve por proyecto** (#21): VSL largo conviene en automático; un video normal, manual.
- **Plantilla de prompt externalizada** (#23): `prompts/veo-video-prompt.md`, editable en runtime sin
  recompilar.
- **Panel de JSON de videos** (#26).
