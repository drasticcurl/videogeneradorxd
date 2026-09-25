# T03 — El motor: tramos (puro), audio (ffmpeg) y la corrida

- **Depende de:** T01. **Recomendado:** T00 (si el spike da una diferencia de duración de más del 5 %,
  este task no se escribe: ver T00 §5)
- **Bloquea:** T05
- **Se puede correr en paralelo con:** T02, T04
- **Archivos que este task puede tocar:** `src/lib/voz/tramos.ts`, `src/lib/voz/audio.ts`,
  `src/lib/voz/corrida.ts` (los tres nuevos). Nada más.

Leé `02-DISENO.md` completo. Tu contrato es **§8, §9 y §10**, más D4, D5, D9, D10, D11, D12, D17, D18
y D21. Es la task más delicada del módulo: acá se decide si el audio queda en su lugar.

---

## 1. Objetivo

- `tramos.ts` es **puro** (solo `import type`) y da exactamente los 5 resultados de §8. Son los
  chequeos B15-B19, que llaman a tu función con `node`.
- `audio.ts` implementa los 7 pasos de §9 con `runFfmpegAsync`: cortes por muestra, video copiado,
  prueba re-encodeada.
- `corrida.ts` implementa el contrato de §10.1 con las 10 reglas de §10.2:
  - cola global;
  - leer y después escribir;
  - reintentos;
  - cancelar;
  - chequeo final;
  - reconciliación tras reinicio.
- B14-B21 en verde.

**No hace rutas ni UI, y no importa `src/lib/voz/index.ts`**: el proveedor llega por parámetro
(diseño §3). Si lo importaras, T02 y T03 no podrían escribirse en paralelo.

---

## 2. Antes de escribir, leé

| Archivo | Qué mirar |
|---|---|
| `02-DISENO.md` §1 | los números que tu código tiene que reproducir: muestras iguales, md5 del video igual |
| `src/lib/ffmpeg.ts` | `stitchProject` (274-414): cómo se arma el grafo; `runFfmpegAsync` (T01) |
| `src/lib/unido.ts` (T01) | `recetaVigente` y `estadoDelUnido`: tu validación de entrada |
| `src/lib/voz/estado.ts` (T01) | `BOOT_ID`, `corridaVivaDe` |
| `src/lib/jobs/queue.ts` | `recuperarTrasReinicio` (127-203): el patrón del guard de una vez por proceso, y el comentario de por qué **no** se corre a nivel de módulo |
| `src/lib/jobs/masivo.ts` | el singleton de estado en `globalThis` (58-61) |
| `src/lib/jobs/pipeline.ts` | `logEvent` (86-106): lo importás, no lo modificás |
| `src/lib/storage.ts` | `slugify`, `absPathFor`, `projectDir`, `removeRel` |

---

## 3. Qué hacer

### `tramos.ts` — puro

Las 4 funciones de §8 con sus reglas. Dos cosas que se olvidan:

- **Tolerancia de punto flotante.** Compará con un epsilon (`1e-9`) al decidir si un clip entra en la
  pieza: `16.06 - 8` no es exactamente `8.06`.
- **Con ventana**, `clipIds` de cada pieza recortada lista **solo** los clips que la tocan dentro de
  la ventana. El caso 4 de §8 es exactamente eso: `c4` empieza en 22,06 y queda afuera de una ventana
  que termina en 20.

### `audio.ts`

Una función por paso de §9, cada una `async` y con `signal`. Firmas libres: las usa solo
`corrida.ts`. Reglas:

- **Todos los cortes son por muestra a 48 kHz.** `n = Math.round(seg × 48000)`. El fin de una pieza es
  **la misma** muestra que el inicio de la siguiente.
- **`N_total` sale del `completo.wav`** (ffprobe `stream=duration_ts`), no de la receta. La última
  pieza va hasta `N_total`, y eso absorbe el relleno del AAC (22,037 contra 22,02 en §1).
- **Después de concatenar, `duration_ts` de `nuevo.wav` tiene que ser igual a `N_total`.** Si no, el
  paso falla. Es la garantía de D5; no se "corrige" con un pad al final.
- **El ajuste de duración del paso 3** (umbrales de 50 ms y 5 %) usa la duración de la salida medida
  con ffprobe **después** de aplicar `VOICE_OFFSET_MS`.
- **Todo error de ffmpeg** sale como `Error("ffmpeg falló en <paso>: <cola de stderr>")`, con los
  últimos 300 caracteres (§14).
- **El remux de la versión completa es `-c:v copy`.** Solo la prueba re-encodea (explicado en §9).

### `corrida.ts`

El contrato de §10.1 **exacto**: T05 lo importa. Lo que no es obvio:

1. **`iniciarCorrida` valida en forma sincrónica**, en el orden de §10.2 regla 1, y lanza
   `ErrorDeCorrida` con el código. Si pasa, crea la `VersionDeVoz`:
   - `estado: "en_cola"`, `bootId: BOOT_ID`, `recetaCreadaEn: receta.creadoEn`;
   - `progreso: { tramosListos: 0, tramosTotal: <piezas que se convierten> }`.

   La agrega **al principio** de `versionesVoz` y la encola. Devuelve la versión: la ruta contesta
   202 con eso.
2. **La cola** es un array en `globalThis` más un flag `procesando`. Al terminar una, arranca la
   siguiente. Nunca dos a la vez (D11).
3. **`actualizarVersion(projectId, versionId, patch)`:**
   - relee con `projectsDb.get`;
   - si el proyecto ya no existe, aborta la corrida (D18);
   - reemplaza **solo** esa versión dentro de `versionesVoz`;
   - `projectsDb.update(projectId, { versionesVoz })`.

   **Nunca** guardes un `ProjectRecord` entero que leíste antes.
4. **El proceso de una versión:**
   1. `procesando`.
   2. Carpeta de trabajo.
   3. Pasos 1-2.
   4. Por cada pieza que se convierte:
      - proveedor, con reintentos (regla 5);
      - archivo de salida;
      - paso 3;
      - `tramosListos++`.
   5. Paso 4 para las que se conservan.
   6. Paso 5.
   7. **El chequeo final (regla 7).**
   8. Paso 6 o 7 a `.tmp.mp4`.
   9. `rename` al nombre de §9.
   10. `lista`, con `file`, `bytes` y `segundosConvertidos`.

   Todo en un `try / catch / finally`. En el `finally` se borra la carpeta de trabajo, siempre.
5. **Cancelar.** Un `AbortController` por versión viva, guardado en el estado de la cola.
   `cancelarCorrida(projectId)`:
   - aborta la que está procesando de ese proyecto, o saca de la cola la que espera;
   - marca `cancelada`;
   - devuelve `true` si había alguna.

   Un `AbortError` **no** se registra como falla.
6. **Los mensajes de falla** son los de §14, textuales. Los `ErrorDeVoz` se traducen por `codigo`.
7. **`reconciliarTrasReinicio`:** un guard de una vez por proceso.
   - Recorre `projectsDb.list()` y marca `fallida` toda versión `en_cola`/`procesando` con `bootId`
     distinto de `BOOT_ID`, con el mensaje de reinicio de §14.
   - Borra `voz/_trabajo/` de esos proyectos.
   - **No** se llama a nivel de módulo (lo explica `queue.ts:707-716`).
8. **El log.** `logEvent` en los cuatro momentos de §10.2 regla 8.

---

## 4. Verificación

```bash
cd /Users/lucho/Desktop/funnel/videogeneradorxd

# 1 — los chequeos de T03 (B15-B19 ejecutan tu funcion con node)
bash tasks/cambio-de-voz/_verificacion-voz.sh | grep '\[T03\]'
# esperado exactamente: 8 lineas "OK" (B14 a B21). Un FALLO en B15-B19 trae esperado vs real.

# 2 — nada sincronico largo en el modulo
grep -nE 'spawnSync' src/lib/voz/audio.ts src/lib/voz/corrida.ts | grep -v ffprobe || echo "sin spawnSync de ffmpeg"
# esperado exactamente: sin spawnSync de ffmpeg

# 3 — corrida.ts no importa el factory (el proveedor es inyectado, diseño §3)
grep -nE 'from "\./index"|from "@/lib/voz"$|getVozProvider' src/lib/voz/corrida.ts || echo "inyectado"
# esperado exactamente: inyectado

# 4 — nunca se guarda un ProjectRecord viejo entero
grep -nE 'projectsDb\.(upsert)\(' src/lib/voz/corrida.ts || echo "solo update de versionesVoz"
# esperado exactamente: solo update de versionesVoz

# 5 — el circuito de audio con ffmpeg real, fuera de la app: reproducí §1 del diseño
#     con TU audio.ts. Script descartable en el scratchpad (no en el repo) que:
#       a) arme 3 clips sintéticos + el unido con el grafo de stitchProject (§1),
#       b) corra tus pasos 1-6 con un "proveedor" que sea el filtro del mock,
#       c) compare: duration_ts(nuevo.wav) == duration_ts(completo.wav)  y
#          md5 del stream de video (ffmpeg -map 0:v -c copy -f md5 -) igual en los dos.
# esperado exactamente: muestras iguales y md5 igual.
#   audio.ts importa "../ffmpeg", que no se puede cargar con node suelto (importa ./db
#   sin extension): el script replica los args de tus funciones o carga el modulo con el
#   bundler de Next. La prueba dentro de la app, de punta a punta, es de T07.

# 6 — typecheck
rm -rf .next && npx tsc --noEmit
# esperado: sin salida
```

---

## 5. Cuándo parar

**Bloqueante, pará y avisá:**

- B15-B19 no dan con una implementación que cumpla las 5 reglas de §8. Puede ser un error del
  ejemplo, no de tu código: **no ajustes los esperados del script**, avisá.
- El paso 5 de la verificación no da muestras iguales o md5 igual. D1 y D5 son la base del módulo.
- T00 midió una diferencia de duración de más del 5 %.

**Anotalo en §17 y seguí:**

- Una duración de tramo distinta de 270 s te parece mejor (por ejemplo, por la latencia medida en
  T00). Es `VOICE_CHUNK_MAX_SEC`: no se cambia el default en código.
