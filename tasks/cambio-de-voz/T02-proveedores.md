# T02 — Proveedores de voz: ElevenLabs, mock, factory y favoritas

- **Depende de:** T01
- **Bloquea:** T05
- **Se puede correr en paralelo con:** T03, T04
- **Archivos que este task puede tocar:** `src/lib/voz/elevenlabs.ts`, `src/lib/voz/mock.ts`,
  `src/lib/voz/index.ts`, `src/lib/voz/favoritas.ts` (los cuatro nuevos). Nada más.

Leé `02-DISENO.md` completo. Tu contrato es **§6** entero, más D13, D14, D15 y D20, y la tabla de
errores de §14.

---

## 1. Objetivo

- `elevenlabs.ts` implementa `VozProvider` contra la API real:
  - listar, `porIds`, convertir y créditos;
  - cache de 60 s;
  - timeout combinado con el `signal`;
  - el mapeo de errores de §6.2.
- `mock.ts` implementa `VozProvider` sin red: 4 voces y una conversión que sube el tono sin cambiar
  la duración.
- `index.ts` elige el proveedor por `config.voz.proveedor` y resuelve la key del usuario.
- `favoritas.ts` guarda las favoritas por usuario en `<DATA_DIR>/voces-favoritas.json`.
- B10-B13 en verde.

**No hace rutas, no conoce proyectos ni la corrida, y no toca `db.ts`** (D14).

---

## 2. Antes de escribir, leé

| Archivo | Qué mirar |
|---|---|
| `src/lib/voz/tipos.ts` (T01) | la interfaz que implementás y `ErrorDeVoz` |
| `src/lib/providers/types.ts` | `parseRetryAfter` (líneas 28-35): **reusalo** para el `Retry-After` de los 429 |
| `src/lib/providers/vertex/video.ts` | cómo este repo hace `fetch` a un proveedor con timeout y maneja los errores HTTP |
| `src/lib/db.ts` | el patrón de persistencia: tmp + rename y singleton por `globalThis`. **Lo copiás, no lo importás ni lo modificás** |
| `src/lib/ffmpeg.ts` | `runFfmpegAsync` (T01), para el mock |

---

## 3. Qué hacer

### `elevenlabs.ts`

- `crearProveedorElevenLabs(key: string): VozProvider`. Recibe la key; **no** lee `process.env`
  (eso es de `config.ts`, chequeo A2).
- Las cuatro llamadas de la tabla de §6.2, con esos parámetros exactos. `voice_type=non-default`
  para "mías" es lo que junta clonadas, diseñadas, profesionales y agregadas de la Voice Library
  (R2.1).
- **`convertir`:**
  - valida `voiceId` con `VOICE_ID_RE` **acá también**, aunque la ruta ya lo haga: la ruta puede
    cambiar, y este archivo es el que arma la URL;
  - arma un `FormData` con `audio` (`new Blob([wav], { type: "audio/wav" })`, nombre `tramo.wav`),
    `model_id`, `remove_background_noise` como string `"true"`/`"false"`, y `voice_settings` como
    JSON **solo si `ajustes` no es null**;
  - `extension` sale de `config.voz.elevenlabs.formatoSalida`: `mp3_*` → `"mp3"`, `wav_*` → `"wav"`.
- **Timeout:** un `AbortController` propio con `setTimeout(timeoutMs)`, más un listener en el
  `signal` de afuera que aborta el propio. **No uses `AbortSignal.any`**: requiere Node ≥ 20.3.
  Cuando termina, limpiá el timer y el listener.
- **Errores:** exactamente la tabla de §6.2. `detail` puede venir como objeto `{ status, message }`
  o como string: manejá los dos. **Ningún mensaje incluye headers ni la key.**
- **Cache de 60 s** para `listar`, `porIds` y `creditos`. La clave es un hash (`node:crypto`
  sha256, 8 caracteres) de la key más los parámetros. **Nunca la key en claro como clave de un
  `Map`**: termina en un heap dump.
- **Normalización:** `previewUrl` solo si empieza con `https://`; `etiquetas` = `labels ?? {}`.

### `mock.ts`

- `crearProveedorMock(): VozProvider`, con las 4 voces y las reglas de §6.3.
- **`convertir`:**
  1. espera `VOICE_MOCK_DELAY_MS` (abortable);
  2. escribe el WAV en `os.tmpdir()`;
  3. corre `asetrate=44100*1.25,aresample=44100,atempo=0.8` con `runFfmpegAsync` pasando el
     `signal`;
  4. lee y borra los temporales, siempre, en un `finally`.
- El filtro está **verificado**: sube el tono un 25 % y la duración queda a 2,6 ms de la original
  (§1).

### `index.ts`

```ts
export function getVozProvider(usuario: string): VozProvider;
export function vozDisponible(usuario: string): { disponible: boolean; motivo: string | null };
```

- **`mock`:** siempre disponible; devuelve un singleton.
- **`elevenlabs`:**
  - `elevenLabsKeyFor(usuario)`;
  - vacía → `ErrorDeVoz(<mensaje de §14 para no_configurado>, "no_configurado")`;
  - con key → un proveedor por key, cacheado por su hash.
- `vozDisponible` además chequea ffmpeg y ffprobe (`hasFfmpeg()` de `providers/placeholder.ts` y un
  `ffprobe -version`).

### `favoritas.ts`

§6.4 al pie de la letra:

- archivo `<config.storage.dataDir>/voces-favoritas.json`;
- escritura tmp + rename;
- singleton por `globalThis`;
- **si el JSON está roto, se renombra a `.roto-<timestamp>` antes de escribir** (y se hace
  `console.error`);
- tope de 50 por usuario;
- alias de 1..60 caracteres;
- ajustes en 0..1.

Las favoritas de otro proveedor **no se mezclan**: se filtra por `proveedor`.

---

## 4. Verificación

```bash
cd /Users/lucho/Desktop/funnel/videogeneradorxd

# 1 — los chequeos de T02
bash tasks/cambio-de-voz/_verificacion-voz.sh | grep '\[T02\]'
# esperado exactamente: 4 lineas "OK" (B10 a B13)

# 2 — la key sigue en su jaula (A2) y ningún cliente importa esto (A7)
bash tasks/cambio-de-voz/_verificacion-voz.sh | grep -E 'A2 |A7 '
# esperado: las dos en OK

# 3 — elevenlabs.ts no lee process.env (la key entra por parámetro)
grep -n 'process\.env' src/lib/voz/elevenlabs.ts || echo "no lee env"
# esperado exactamente: no lee env

# 4 — no usa AbortSignal.any (Node >= 20.3; engines dice >= 18.18)
grep -n 'AbortSignal\.any' src/lib/voz/*.ts || echo "sin AbortSignal.any"
# esperado exactamente: sin AbortSignal.any

# 5 — el mapeo de errores cubre la tabla de §6.2
for c in sin_creditos sin_permiso key_invalida validacion voz_inexistente limite red timeout; do
  grep -q "\"$c\"" src/lib/voz/elevenlabs.ts && echo "ok $c" || echo "FALTA $c"
done
# esperado exactamente: 8 lineas "ok"

# 6 — las favoritas no tocan db.json
grep -nE "from \"(\.\./)+db\"|db\.json" src/lib/voz/favoritas.ts || echo "archivo propio"
# esperado exactamente: archivo propio

# 7 — typecheck
rm -rf .next && npx tsc --noEmit
# esperado: sin salida
```

**Con key disponible (opcional pero recomendado):** una prueba de humo de `listar("predeterminadas")`
y `creditos()` contra la API real, desde un script **fuera del repo**. Que `listar` devuelva voces con
`previewUrl` https confirma la normalización. **No conviertas nada acá**: eso lo mide T00.

---

## 5. Cuándo parar

**Bloqueante, pará y avisá:**

- La interfaz de `tipos.ts` no alcanza para algo de §6.2. **No la cambies**: T03 y T05 se escriben
  contra ella.
- `GET /v2/voices` no acepta `voice_type=non-default` (lo dice el error 422). Cambia R2.1: pará.

**Anotalo en §17 y seguí:** ElevenLabs devuelve un campo útil que el contrato no pide (por ejemplo,
`verified_languages`). No lo agregues a `VozResumen`.
