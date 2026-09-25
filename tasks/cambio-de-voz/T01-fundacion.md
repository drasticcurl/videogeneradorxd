# T01 — Fundación: tipos, configuración, el estado del unido y ffmpeg asíncrono

- **Depende de:** nada
- **Bloquea:** T02, T03, T04, T05 y T06. Declarás los contratos que importan.
- **Se puede correr en paralelo con:** T00 (no toca `src/`). **Con nada más.**
- **Repo:** `/Users/lucho/Desktop/funnel/videogeneradorxd`
- **Archivos que este task puede tocar:** `src/lib/types.ts`, `src/lib/config.ts`, `.env.example`,
  `src/lib/ffmpeg.ts` (**solo agregar** `runFfmpegAsync`), `src/lib/unido.ts` (nuevo),
  `src/lib/voz/tipos.ts` (nuevo), `src/lib/voz/estado.ts` (nuevo). Nada más.

Leé `01-REQUISITOS.md` y `02-DISENO.md` completos. Tu contrato es **§4, §5, §6.1 (solo `tipos.ts`),
§7.2 y el `runFfmpegAsync` de §9**. Copiá las firmas tal cual: **no las mejores**. Hay cinco tasks
que se escriben contra ellas al mismo tiempo.

**Si esta task falla, se para el proyecto.**

---

## 1. Objetivo

Cuando termines:

- `types.ts` tiene los 13 tipos de §4 y los dos campos **opcionales** en `ProjectRecord`.
- `config.ts` tiene el bloque `voz` y `elevenLabsKeyFor()`.
- `.env.example` documenta las variables de §5, y su cabecera ya no dice que no hay API keys.
- `src/lib/voz/tipos.ts` exporta `VOICE_ID_RE`, los tipos del proveedor y `ErrorDeVoz`.
- `src/lib/voz/estado.ts` exporta `BOOT_ID`, `esCorridaViva` y `corridaVivaDe`.
- `src/lib/unido.ts` exporta `estadoDelUnido` y `recetaVigente`, y solo lee.
- `src/lib/ffmpeg.ts` exporta `runFfmpegAsync`. `runFfmpeg` se comporta **exactamente igual** que
  antes.
- `_verificacion-voz.sh` da B2-B9 en verde y FALLO 0. `tsc` limpio.

**Este task no crea rutas, no toca la UI y no cambia `stitchProject`** (es de T04).

---

## 2. Antes de escribir, leé

| Archivo | Qué mirar | Qué NO hacer |
|---|---|---|
| `src/lib/types.ts` | cómo están comentados los opcionales de `ProjectRecord` (`owner?`, `batch?`, `stage?`): el por qué + el bug que evita | no cambiar ningún tipo existente |
| `src/lib/config.ts` | `authUsers()` (línea 353): lee `process.env` en cada llamada, y el comentario explica por qué no se cachea. `elevenLabsKeyFor` va igual | no cambiar `MODEL_CATALOG` ni nada de `pipeline`/`auth` |
| `src/lib/ffmpeg.ts` | `runFfmpeg` (líneas 150-184): el cálculo de cores, `taskset` y el fallback con `-threads` | **no cambiar su comportamiento**. Lo usan el stitch y el extend de video |
| `src/lib/storage.ts` | `buildManifest` (190) y `existsRel`, `absPathFor` | no modificarlo: es intocable en este módulo |
| `src/lib/jobs/masivo.ts` | el singleton por `globalThis` (58-61) | — |

---

## 3. Qué hacer, archivo por archivo

### `src/lib/types.ts`

- Los 13 tipos de §4, **tal cual**, con un comentario por tipo que diga para qué existe.
- En `ProjectRecord`, `recetaUnido?: RecetaUnido;` y `versionesVoz?: VersionDeVoz[];`, cerca de los
  otros opcionales.
- **Los dos son opcionales a propósito.** Si fueran obligatorios, `tsc` rompería en todos los
  lugares que construyen un `ProjectRecord`, y eso es la colisión que el plan evita. Es el mismo
  criterio que usó `owner?` (D2 del plan de aislamiento).

### `src/lib/config.ts`

- El bloque `voz` dentro de `config`, con las claves exactas de §5. Van acotadas como dice la
  tabla: `tramoMaxSeg` a 30..290, `pruebaSeg` a 5..60, `offsetMs` a 0..500.
- **Si `formatoSalida` no empieza con `mp3_` ni `wav_`, cae a `mp3_44100_128`**. Poné el comentario
  de por qué: `pcm_` es audio sin cabecera (D20).
- `export function elevenLabsKeyFor(usuario: string): string`, con el comentario de por qué no se
  cachea (el mismo de `authUsers`).

### `.env.example`

- Una sección `# --- Cambio de voz (ElevenLabs) ---` con **todas** las variables de §5, cada una con
  su comentario. Las keys van vacías.
- Arriba de las keys, una línea de cómo crear una key **restringida**: Speech to Speech + Voices
  (lectura) + User (lectura, opcional).
- La cabecera cambia de *"NO pongas API keys ni service accounts: la autenticacion es por ADC"* a:
  Vertex usa ADC; ElevenLabs usa una API key que va **solo** en `.env.local` /
  `.env.production`, que están en `.gitignore`.

### `src/lib/voz/tipos.ts`

§6.1 completo: `VOICE_ID_RE`, `ListaDeVoces`, `PaginaDeVoces`, `ConvertirInput`,
`ConvertirResultado`, `VozProvider`, `CodigoErrorDeVoz`, `ErrorDeVoz`. `ErrorDeVoz`:

- tiene `codigo`, `status` y `retryAfterMs?` como campos **explícitos**, no parameter properties;
- tiene `reintentable` como getter: `true` solo para `limite`, `red` y `timeout`;
- tiene `name = "ErrorDeVoz"`.

### `src/lib/voz/estado.ts`

```ts
import { randomUUID } from "node:crypto";
import type { ProjectRecord, VersionDeVoz } from "../types";
// BOOT_ID: singleton en globalThis (sobrevive al HMR; cambia con cada proceso). Ver D12.
export const BOOT_ID: string;
export function esCorridaViva(v: VersionDeVoz): boolean;          // (en_cola|procesando) && bootId === BOOT_ID
export function corridaVivaDe(project: ProjectRecord): VersionDeVoz | null;
```

El comentario de cabecera explica el bug que evita: una versión que quedó "procesando" cuando el
server se reinició bloquearía "Volver a unir" para siempre.

### `src/lib/unido.ts`

§7.2 completo, con los motivos **textuales** de la tabla. `NN` es la posición en dos dígitos.

- Los clips actuales salen de `buildManifest(project, jobs).clips`, filtrados igual que en
  `stitchProject`: `c.file && existe en disco`, ordenados por `orden`.
- La huella se compara con `Math.trunc(fs.statSync(abs).mtimeMs)` y `.size`.
- **Solo lectura:** ni `projectsDb.update` ni `writeManifest` acá. Se llama en cada polling.

### `src/lib/ffmpeg.ts` — solo `runFfmpegAsync`

```ts
export function runFfmpegAsync(
  args: string[],
  opts?: { cwd?: string; signal?: AbortSignal },
): Promise<{ code: number | null; stderr: string }>;
```

- **Misma limitación de cores que `runFfmpeg`.** Sacá el armado de `[comando, args]` a un helper
  **privado** que usen las dos, así no divergen. `runFfmpeg` tiene que seguir devolviendo lo mismo
  para los mismos args.
- `spawn`, no `spawnSync`, con `stdio ["ignore", "ignore", "pipe"]`. Guarda los **últimos 4.000
  caracteres** de stderr.
- **Resuelve** en `close` con el `code`, sea el que sea: quien llama decide qué es un error.
  **Rechaza** si el spawn falla (ffmpeg no está) o si se abortó.
- **Con `signal` abortado:** `child.kill("SIGKILL")` y rechaza con un `Error` de `name =
  "AbortError"`. Si el `signal` ya venía abortado, rechaza sin hacer spawn.

---

## 4. Verificación

```bash
cd /Users/lucho/Desktop/funnel/videogeneradorxd

# 1 — los chequeos de T01
bash tasks/cambio-de-voz/_verificacion-voz.sh | grep '\[T01\]'
# esperado exactamente: 8 lineas "OK" (B2 a B9), ninguna PENDIENTE ni FALLO

# 2 — los invariantes siguen en verde
bash tasks/cambio-de-voz/_verificacion-voz.sh | tail -3
# esperado:  verde: 18   pendiente: 32   FALLO: 0   (19/31 si T00 ya corrió)

# 3 — los dos campos nuevos son OPCIONALES
grep -nE '^\s+(recetaUnido|versionesVoz):' src/lib/types.ts || echo "ninguno obligatorio"
# esperado exactamente: ninguno obligatorio

# 4 — unido.ts no escribe
grep -nE '\.(update|upsert|remove)\(|writeManifest|writeFile' src/lib/unido.ts || echo "solo lecturas"
# esperado exactamente: solo lecturas

# 5 — runFfmpeg sigue igual: mismo comando armado para los mismos args
git diff src/lib/ffmpeg.ts | grep -E '^-' | grep -vE '^---' | head
# esperado: nada, o solo líneas movidas al helper privado con la MISMA lógica (revisalo a ojo)

# 6 — typecheck (pedido explícito del plan)
rm -rf .next && npx tsc --noEmit
# esperado: sin salida, exit 0
#   runFfmpegAsync no se puede ejecutar suelto con node (ffmpeg.ts importa ./db sin
#   extension): la prueba con ffmpeg real, incluida la cancelacion, es de T03 y T07.

# 7 — no rompiste ningún endpoint
bash tasks/_verificacion-endpoints.sh | tail -1
# esperado exactamente: SIN REGRESIONES
```

**El paso 1 es la compuerta.** Hasta que B2-B9 estén en verde con FALLO 0, la ola 2 no arranca.

---

## 5. Cuándo parar

**Bloqueante, pará y avisá:**

- Alguna firma de §4-§7 **no se puede implementar como está**. **No la cambies**: pará y avisá.
- Extraer el helper de `runFfmpeg` cambia su comportamiento para algún caso (por ejemplo, con
  `FFMPEG_CORES` o sin `taskset`). El stitch y el extend dependen de él.
- `tsc` falla por algo que no es tu código.

**Anotalo en §17 del diseño y seguí:**

- Te parece que falta un tipo o un campo. Anotalo, no lo agregues: si nadie lo pidió, ninguna task
  lo va a usar.
- Necesitás modificar un archivo ajeno → **nunca**. Anotalo.
