# Registro de cambios

Toda tanda de cambios se anota acá, arriba. Formato: fecha, qué cambió y **por qué** (el bug que
evita o el problema que resuelve). El detalle línea por línea vive en `git log`; esto es para
entender el estado sin leer 70 commits.

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
