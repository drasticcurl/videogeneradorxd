# CAMBIO DE VOZ — Tasks

Sale de `01-REQUISITOS.md` (qué) y `02-DISENO.md` (cómo). Este archivo dice **en qué orden, quién toca
qué archivo y cómo se sabe que terminó**. Cada task tiene su archivo `TNN-*.md`, y
`PROMPT-CLAUDE-CODE.md` trae los prompts listos para pegar.

```
tasks/cambio-de-voz/
├── 01-REQUISITOS.md             qué tiene que pasar (R1-R12, EARS)
├── 02-DISENO.md                 cómo: decisiones D1-D21 y contratos congelados. TODOS lo leen completo
├── 03-TASKS.md                  este archivo
├── PROMPT-CLAUDE-CODE.md        los prompts
├── _verificacion-voz.sh         la aceptación del módulo. YA CORRIÓ (ver abajo)
├── T00-spike-elevenlabs.md      medir ElevenLabs de verdad. Necesita la API key
├── T01-fundacion.md             tipos, config, unido.ts, runFfmpegAsync. VA SOLA
├── T02-proveedores.md           ElevenLabs, mock, favoritas
├── T03-motor.md                 tramos (puro), audio (ffmpeg), corrida (la cola)
├── T04-unido-con-receta.md      el stitch guarda la receta; 409 con conversión viva
├── T05-rutas.md                 /api/voces, /api/voces/favoritas, /api/projects/:id/voz + 2 rutas existentes
├── T06-ui.md                    Resultado + el diálogo
├── T07-verificacion-y-docs.md   E2E en mock, deploy.sh, README, CHANGELOG, steering
└── T08-produccion.md            key en el server, deploy, QA con audio real. VA SOLA Y ÚLTIMA
```

## Punto de partida — medido, no estimado

```bash
bash tasks/cambio-de-voz/_verificacion-voz.sh | tail -3
#  verde: 10   pendiente: 40   FALLO: 0
```

- **10 invariantes en verde:**
  - el stitch sigue chequeando dueño;
  - la key no sale del server;
  - `db.ts` no cambia de forma;
  - las dos líneas base del repo siguen verdes;
  - el resto de A1-A10.
- **40 objetivos pendientes**, con la task dueña entre corchetes.

El script en sí también se probó:

- con archivos que cumplen el contrato da 50/50;
- con cuatro implementaciones rotas a propósito da **FALLO**, no "pendiente".

Y antes de escribir el diseño se verificó con ffmpeg real el circuito de audio completo
(`02-DISENO.md` §1):

- pista nueva con las mismas muestras que la original;
- video con el mismo md5.

---

## 1. Las tasks

| Task | Qué | Archivos | Chequeos |
|---|---|---|---|
| **T00** | Spike: medir tiempos, facturación, formatos y latencia de ElevenLabs con audio real de Veo | `_spike-elevenlabs.mjs`, `_spike-resultados.md` (nuevos, en esta carpeta) | B1 |
| **T01** | Fundación: los contratos de §4-§7 | `src/lib/types.ts`, `src/lib/config.ts`, `.env.example`, `src/lib/ffmpeg.ts` (**solo** `runFfmpegAsync`), `src/lib/unido.ts`, `src/lib/voz/tipos.ts`, `src/lib/voz/estado.ts` | B2-B9 |
| **T02** | Proveedores: ElevenLabs, mock, factory y favoritas | `src/lib/voz/elevenlabs.ts`, `mock.ts`, `index.ts`, `favoritas.ts` (nuevos) | B10-B13 |
| **T03** | Motor: tramos (puro), audio (ffmpeg) y la corrida | `src/lib/voz/tramos.ts`, `audio.ts`, `corrida.ts` (nuevos) | B14-B21 |
| **T04** | El stitch guarda la receta y contesta 409 con conversión viva | `src/lib/ffmpeg.ts` (**solo** `stitchProject`/`StitchResult`), `src/app/api/projects/[id]/stitch/route.ts` | B22-B23 |
| **T05** | Las rutas HTTP | `src/app/api/voces/route.ts`, `src/app/api/voces/favoritas/route.ts`, `src/app/api/projects/[id]/voz/route.ts` (nuevos), `src/app/api/projects/[id]/route.ts`, `src/app/api/projects/[id]/download/route.ts` | B24-B28 |
| **T06** | UI: Resultado y el diálogo | `src/app/project/[id]/result/page.tsx`, `src/components/CambiarVozDialog.tsx` (nuevo), `src/lib/ui-tokens.ts`, `tasks/_verificacion-endpoints.sh` (una línea) | B29-B32 |
| **T07** | E2E en mock, UI funcional, deploy y documentación | `tasks/cambio-de-voz/_verificacion-voz-mock.mjs` (nuevo), `tasks/_verificacion-ui-funcional.mjs`, `deploy/deploy.sh`, `README.md`, `CHANGELOG.md`, `docs/BITACORA-IMPLEMENTACION.md`, `.kiro/steering/project-context.md` | B33-B39 |
| **T08** | Producción: key, deploy, QA con audio real, cerrar P-01 a P-03 | §17 de `02-DISENO.md`, `CHANGELOG.md`. **Nada de `src/`** | B40 |

---

## 2. Olas

```
  OLA 1                 OLA 2                     OLA 3              OLA 4        OLA 5
 ┌──────┐          ┌──────┬──────┬──────┐     ┌──────┬──────┐      ┌──────┐     ┌──────┐
 │ T01  │ ───────► │ T02  │ T03  │ T04  │ ──► │ T05  │ T06  │ ───► │ T07  │ ──► │ T08  │
 │ sola │          │ prov │motor │unido │     │rutas │  UI  │      │verif │     │ prod │
 └──────┘          └──────┴──────┴──────┘     └──────┴──────┘      └──────┘     └──────┘
 ┌──────┐               ▲
 │ T00  │ ──────────────┘  recomendada ANTES de T03 (ver abajo)
 │spike │  en paralelo con T01: no toca src/
 └──────┘
```

| Task | Depende de | Se puede correr junto con |
|---|---|---|
| T00 | la API key | T01 (y cualquier otra: no toca `src/`) |
| T01 | — | T00. **Nada más de `src/`** |
| T02 | T01 | T03, T04 |
| T03 | T01 (y T00, recomendado) | T02, T04 |
| T04 | T01 | T02, T03 |
| T05 | T02, T03, T04 | T06 |
| T06 | T01 (tipos) + el contrato HTTP de §11 | T05 |
| T07 | T05, T06 | nada |
| T08 | T07 y la key en el server | nada. **Va sola y última** |

**Por qué T01 va sola.** Declara los tipos, la config, `unido.ts`, `estado.ts` y `runFfmpegAsync`, que
importan las tres tasks de la ola 2. Sin esos archivos, las tres fallan el `tsc` en la primera línea.

**Por qué T02, T03 y T04 pueden ir juntas:**

- tocan archivos **disjuntos**;
- las tres importan **solo** lo que dejó T01.

La trampa es `corrida.ts` (T03), que necesita un proveedor. No importa `voz/index.ts` (T02): recibe
el proveedor por parámetro (diseño §3). T04 y T01 tocan los dos `src/lib/ffmpeg.ts`, pero en olas
distintas y en funciones distintas.

**Por qué T05 y T06 pueden ir juntas:**

- T06 se escribe contra el **contrato** HTTP de §11, no contra la implementación de T05. Es el mismo
  criterio que usó el plan de aislamiento con su T07.
- La prueba de punta a punta es de T07.

**T00 y la ola 2.** Si ya tenés la key, corré T00 **antes** de T03. Si el spike muestra que ElevenLabs
**no** respeta los tiempos (diferencia de duración de más del 5 %), §8-§9 del diseño cambian y T03
se escribiría en vano. Si todavía no tenés key, la ola 2 puede arrancar igual: todo lo que el spike
calibra es una variable de entorno (formato, offset, facturación, timeout), y T08 lo ajusta.

**De a uno:** T00 → T01 → T04 → T02 → T03 → T05 → T06 → T07 → T08. T04 va temprano porque, desde
ahí, todo lo que se une nace con receta, y eso sirve para probar a mano lo que viene.

### Compuertas

- **Una task que bloquea a otras no está terminada hasta que su verificación pasa.** Además, al
  terminar cada task, `_verificacion-voz.sh` tiene que seguir en **FALLO: 0**.
- **La ola 2 no arranca** hasta que T01 dé B2-B9 en verde y `npx tsc --noEmit` limpio.
- **La ola 4 no arranca** hasta que B2-B32 estén en verde.
- **T08 no arranca** hasta que `_verificacion-voz-mock.mjs` diga `VOZ OK (mock)`.

**Si T01 se desvía del contrato de §4-§7, se para el proyecto.** Seis tasks se escriben contra esas
firmas. Si algo no se puede implementar como está, el agente **para y avisa**; no lo arregla por su
cuenta.

---

## 3. Ownership de archivos — regla anti-colisión

**Cada task solo escribe los archivos de su fila de §1.** Si necesita algo de un archivo ajeno, lo lee
pero no lo escribe. Si cree que necesita escribirlo, va a §17 del diseño.

Los dos casos que **parecen** colisión y no lo son:

- **`src/lib/ffmpeg.ts` lo tocan T01 y T04, en olas distintas.** T01 **solo agrega**
  `runFfmpegAsync` (y un helper privado que comparte con `runFfmpeg`). T04 **solo** cambia
  `StitchResult` y `stitchProject`. Ninguno toca lo del otro.
- **`src/app/api/projects/[id]/`** tiene archivos de T04 (`stitch/`) y de T05 (`voz/`,
  `route.ts`, `download/`). Son archivos distintos del mismo directorio: mirá la fila antes de abrir
  uno.

**Archivos que NADIE toca en este módulo**, y romper esto rompe cosas que ya funcionan:

```
src/lib/db.ts                        las favoritas van en su propio archivo (D14). Chequeo A6
src/lib/jobs/queue.ts                la voz tiene su propia cola (D11)
src/lib/jobs/pipeline.ts             se IMPORTA logEvent, no se modifica
src/lib/jobs/masivo.ts               no tiene nada que ver
src/lib/storage.ts                   se importan slugify/absPathFor/removeRel/buildManifest; no cambia
src/lib/schema.ts                    el PlanJSON no cambia
src/lib/providers/**                 son de Vertex (D11). Se importa parseRetryAfter, nada más
src/lib/auth.ts, src/middleware.ts   el login no cambia
src/lib/ownership.ts                 ya tiene lo que hace falta (requireProjectOwner, sessionUser)
src/app/api/files/[...path]/route.ts ya sirve .mp4 de cualquier subcarpeta, con Range y ?dl=1&name=
src/app/api/config/route.ts          el estado de la voz sale de GET /voz, no de /api/config
src/app/project/[id]/pipeline/**     la voz vive en Resultado
src/components/ui/**                 las primitivas están congeladas (plan de rediseño §5)
```

**Los archivos de estado no son archivos del repo.** `db.json`, `voces-favoritas.json` y todo lo de
`output/` se crean en runtime y están en `.gitignore`. Ninguna task los edita a mano.

---

## 4. Criterios de aceptación globales

1. `bash tasks/cambio-de-voz/_verificacion-voz.sh` → **CAMBIO DE VOZ COMPLETO** (verde 50, pendiente
   0, FALLO 0). Antes de empezar: verde 10, pendiente 40, FALLO 0.
2. `node tasks/cambio-de-voz/_verificacion-voz-mock.mjs` → **VOZ OK (mock)**. Son los 14 casos de
   punta a punta de T07 §3. Entre ellos:
   - video idéntico (md5);
   - misma cantidad de muestras;
   - un `FILMAR_REAL` conservado byte por byte;
   - unido desactualizado detectado y bloqueado;
   - el 409 con conversión viva;
   - cancelar;
   - borrar la versión;
   - el zip;
   - el aislamiento entre usuarios;
   - borrar el proyecto a mitad de conversión sin que la carpeta reaparezca.
3. `bash tasks/_verificacion-endpoints.sh` → **SIN REGRESIONES**, con una sola línea nueva (la del
   diálogo) y su motivo arriba.
4. `bash tasks/_verificacion-acciones-alcanzables.sh` → **TODAS LAS ACCIONES SON ALCANZABLES**, con
   28 rutas revisadas en vez de 25.
5. `node tasks/_verificacion-ui-funcional.mjs` → **UI OK**, incluidos "Cambiar voz" y "Volver a unir"
   en Resultado, y Resultado sin desbordes en los tres tamaños de laptop.
6. `npx tsc --noEmit` limpio y `npm run build` compila. Solo en las compuertas de cada task: el
   steering prohíbe correrlos por iniciativa propia, y acá es un pedido explícito del plan.
7. **Nada de lo que ya funcionaba cambió:**
   - un proyecto sin conversiones se ve igual que antes;
   - "Unir en un video" hace lo mismo;
   - el `manifest.json` tiene exactamente los mismos campos;
   - `db.json` solo gana los dos campos opcionales en los proyectos que usan la función.
8. **En producción (T08)**, con audio real de Veo:
   - un video de 30-60 s convertido **se ve sincronizado** a ojo, en los cortes entre clips y al
     final;
   - los créditos consumidos coinciden con la estimación (±1 tramo);
   - la descarga tiene nombre legible;
   - el zip incluye la versión.

---

## 5. Requisito → cómo se comprueba

| Req | Chequeo automático | A ojo (T08) |
|---|---|---|
| R1 | E2E 5-6 (md5 del video, muestras, audio distinto en lo convertido), B15-B17 | sincronía en los cortes |
| R2 | E2E 12 (listas mock), T06 §Verificación | que "Mis voces" traiga lo de la cuenta real |
| R3 | E2E 12 (favorita por usuario), B13 | alias y ajustes guardados en la real |
| R4 | E2E 4 (prueba de ~20 s), B18 | que la prueba represente al video |
| R5 | E2E 9-10 (zip, borrar), B28 | nombre de la descarga |
| R6 | E2E 6 (el `FILMAR_REAL` queda idéntico), B15-B16 | — |
| R7 | E2E 5 y 7 (409, cancelar), B21 | que la app no se congele durante una conversión larga |
| R8 | E2E 8 (desactualizado → bloqueado → volver a unir), B22-B23 | — |
| R9 | B19, E2E 3 (estimación) | créditos reales contra estimados |
| R10 | T02 §Verificación 5 (mapeo de errores), E2E 8 (desactualizado → 400 con motivo) y 12 (voiceId inválido → 400) | un error real de ElevenLabs (voz inexistente, medido en T00) |
| R11 | A2, A7, A10, B26, B27, E2E 11 y 13 | que la key no aparezca en la pestaña Red del navegador |
| R12 | todo el E2E corre en mock | — |
