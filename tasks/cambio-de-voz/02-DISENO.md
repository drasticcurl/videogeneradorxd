# CAMBIO DE VOZ — Diseño

**Documento maestro del módulo. Todo agente lee `01-REQUISITOS.md` y este archivo completos antes de
abrir su task.**

Las secciones marcadas **CONTRATO** están congeladas: hay tasks que se escriben contra ellas al mismo
tiempo. Nadie las cambia, ni para mejorarlas. Lo que este documento no resuelve se anota en §17 y
**no se decide en el código**.

---

## 0. En una pantalla

```
                      Resultado ─ "Cambiar voz" ─ elige voz (favoritas / mis voces / predeterminadas)
                                       │
                                       ▼
  POST /api/projects/:id/voz  { accion: "convertir" | "probar", voz, ajustes, quitarRuido, incluirFilmados }
                                       │  202 al instante, la corrida sigue sola
                                       ▼
                    src/lib/voz/corrida.ts   (cola propia: UNA conversión a la vez en toda la app)
                                       │
  1. receta vigente del unido ─────────┤  (si está desactualizado: no arranca → "volvé a unir")
  2. audio completo del unido ─────────┤  ffmpeg: PCM 48 kHz estéreo
  3. piezas: convertir / conservar ────┤  tramos ≤ 270 s cortados en bordes de clip
  4. cada tramo → proveedor ───────────┤  ElevenLabs speech-to-speech (o mock)
  5. normalizar cada salida ───────────┤  mismas muestras exactas que el tramo original
  6. concatenar piezas ────────────────┤  pista nueva, mismo largo que la original
  7. remux sobre el MISMO video ───────┘  -c:v copy  →  voz/<proyecto>__voz-<voz>-<id>.mp4
                                       │
                                       ▼
          ProjectRecord.versionesVoz[]  ←  Resultado hace polling de GET /api/projects/:id/voz
```

**Lo que no cambia:** los clips, el unido original, la cola de Vertex (`queue.ts`), el pipeline, el
login, `db.ts`.

---

## 1. Verificado antes de escribir este documento

**Con ffmpeg 8.1.2 real**, el 2026-09-25, sobre tres clips sintéticos tipo Veo (720x1280 a 24 fps,
AAC estéreo 48 kHz). Los clips tienen, **a propósito**, duraciones de audio y video distintas: el
audio de c2 dura 60 ms más que su video y el de c3, 40 ms menos.

| Qué se midió | Resultado | Qué habilita |
|---|---|---|
| El grafo **exacto** de `stitchProject` (`src/lib/ffmpeg.ts:356-404`) con esos clips | El concat usa **el stream más largo de cada clip** como largo del segmento. El tono de c3 arranca en 16,06 s (8 + 8,06), no en 16,0. El video no se desfasa: congela el último frame de c2 (un frame de 0,125 s en 15,958) y c3 arranca en 16,083 | **La fórmula de la receta:** `inicio(i) = Σ duración de formato de los clips anteriores`. `probeDuration()` ya lee la duración de formato, que es la del stream más largo |
| Extraer el audio del unido → cortar un tramo por muestras → "convertir" (mock: tono +25 %) → normalizar a las mismas muestras → concatenar con la pieza conservada | Muestras de la pista original: **1.057.792**. Muestras de la nueva: **1.057.792** | La pista nueva mide exactamente lo mismo: no hay deriva acumulada |
| Remux con `-c:v copy` | **md5 del stream de video idéntico** entre el unido y la versión (`d9989cfad06266a49214fd78c763c433`). Misma duración: 22,037 s | El video no se toca. Tarda segundos |
| Alineación | El clip conservado (c3) arranca a los 16,0907 s en la versión y a los 16,0930 s en el original: 2 ms de diferencia, dentro del error de medición del filtro. Los tonos convertidos quedaron donde estaban los originales | Lo convertido y lo conservado quedan en el mismo lugar |
| La salida del mock dura 2,6 ms menos que la entrada (16,0573 contra 16,06 s) | La normalización con `apad` + `atrim=end_sample` lo absorbe | Hace falta normalizar siempre, no solo cuando ElevenLabs difiere |
| Node 24.14 importa un `.ts` que solo tiene `import type` | Funciona (type stripping por defecto) | `tramos.ts` se puede probar con `node` sin framework (§8) |

**Contra la documentación de ElevenLabs**, el 2026-09-25:

- Endpoint `POST /v1/speech-to-speech/{voice_id}` (multipart) y listado `GET /v2/voices`.
- Máximo **300 s y 50 MB** por pedido.
- **1.000 créditos por minuto**, y **US$0,12 por minuto** por API.
- Modelos: `eleven_multilingual_sts_v2` (29 idiomas) y `eleven_english_sts_v2`.
- Formatos: `output_format`, de `mp3_22050_32` a `wav_48000`.
- Límite de concurrencia por plan: Free 2, Starter 3, Creator 5, Pro 10.
- Errores: `429` con `too_many_concurrent_requests` o `system_busy`, y `401` con
  `quota_exceeded`.

**NO verificado, y por eso existe T00:** los tiempos reales de ElevenLabs sobre audio de Veo, si
factura por segundo o redondea al minuto, y qué formatos de salida acepta el plan del usuario.

---

## 2. Decisiones cerradas

**D1 — Se cambia el audio del video UNIDO. No se reprocesan los clips ni se vuelve a unir.** Se
extrae el audio del unido, se convierte y se vuelve a montar sobre el **mismo** stream de video con
`-c:v copy` (verificado: md5 idéntico). La alternativa era convertir el audio de cada clip y volver a
correr el stitch. Se descartó porque el stitch re-encodea todo: medido en la VPS, 0,8 s de reloj por
segundo de video, o sea unos 10 minutos en un VSL de 12. Y es `spawnSync`: la app entera queda
congelada para los dos usuarios mientras tanto.

**D2 — Voice Changer (speech-to-speech), no texto a voz.** Speech-to-speech conserva tiempos, pausas y
entonación del audio original, y eso es lo que mantiene el lip-sync. Texto a voz regeneraría el
habla con sus propios tiempos: el diálogo quedaría corrido de la boca en todos los clips.

**D3 — Una sola voz para todo el video (U2).** Todos los tramos van a la misma `voice_id`. La receta
igual guarda el `assetId` de cada clip (§4). Así, si algún día se quiere una voz por persona, alcanza
con cambiar el armado de piezas, sin obligar a volver a unir todos los videos.

**D4 — Tramos de hasta 270 s, cortados en el borde entre dos clips.** El límite de ElevenLabs es
300 s: 270 deja margen para redondeos y para el relleno del AAC. Se corta en bordes de clip porque:

- ahí casi siempre hay una pausa;
- nunca se parte una palabra;
- son **pocos pedidos**.

La alternativa, un pedido por clip, se descartó por costo: si ElevenLabs redondea al minuto por
pedido (P-01), 95 pedidos de 8 s se facturan como 95 minutos en vez de 13. Además, cada pedido
tendría 8 s de contexto en vez de 4 minutos.

**D5 — Cada pieza de la pista nueva tiene EXACTAMENTE las muestras de su tramo original.** Se
normaliza con `apad` + `atrim=end_sample=N` siempre. Si la salida difiere en más de 50 ms, primero se
ajusta con `atempo`, que conserva el tono. Si difiere en más del 5 %, el tramo falla. Sin esto, un
error de 20 ms por tramo se acumula y el final del video queda corrido de la boca. Verificado: la
pista nueva tiene las mismas 1.057.792 muestras que la original.

**D6 — El stitch guarda la RECETA del unido en el proyecto** (`ProjectRecord.recetaUnido`, §7). La
receta dice qué clips entraron, en qué orden, dónde empieza y termina cada uno, y la huella de cada
archivo (`mtimeMs` + `bytes`). Sin receta no hay forma confiable de saber:

- **dónde cae cada clip dentro del unido.** Hace falta para conservar los que no se convierten
  (R6).
- **si el unido sigue correspondiendo a los clips.** Si se regeneró un clip después de unir, la voz
  nueva se pegaría sobre un video que ya no es el de los clips actuales. Es el hueco de R8.

**D7 — Un unido sin receta (unido antes de este módulo) obliga a volver a unir una vez. No se
reconstruye la receta a posteriori.** Reconstruirla sondeando los clips actuales da números
plausibles aunque un clip haya cambiado después de unir. Las cuentas cerrarían y el audio quedaría
pegado sobre otro video, sin un solo error. Volver a unir cuesta CPU; adivinar mal cuesta un video
entregado con la voz corrida.

**D8 — El original nunca se pisa.** Cada conversión es un archivo nuevo en
`<proyecto>/voz/`. Si una voz no gusta, se borra la versión; el unido sigue intacto sin tener que
volver a unir.

**D9 — Qué se conserva:**

- **Los clips sin diálogo se conservan siempre.** Su audio es solo ambiente, y pasarlo por el Voice
  Changer produce artefactos o silencio.
- **Los `FILMAR_REAL` se conservan por defecto** y se pueden incluir con un interruptor. Son la voz
  real de una persona, y cambiarla sin pedirlo es lo último que se espera.

"Con diálogo" es `clip.dialogo.trim() !== ""`, tomado del plan al momento de unir.

**D10 — Asíncrono, con el estado persistido en el proyecto y polling desde la UI.** El `POST`
devuelve 202 al instante. Un `POST` que esperara el resultado moriría en el camino:

- **Cloudflare corta a los 100 s con un 524** y el trabajo quedaría a medias.
- **Un proceso largo bloquearía el event loop** del único proceso de la app.

**D11 — Módulo propio `src/lib/voz/`, con cola propia: una conversión a la vez en toda la app.** Se
descartaron las dos alternativas:

- **Meterla en `queue.ts`** como otro tipo de job. Esa cola tiene fases, lotes de aprobación,
  rate limit de Veo y recuperación tras reinicio. Es el archivo más delicado del repo, y nada de eso
  aplica acá.
- **Meterla en `src/lib/providers/`.** Ese factory es de Vertex, se elige por `PROVIDER_MODE` y se
  autentica con ADC. ElevenLabs usa API key y se elige aparte.

Una a la vez porque ElevenLabs limita la concurrencia por plan (Free 2) y porque la VPS comparte CPU
con los funnels.

**D12 — Un reinicio NO retoma la conversión: la marca fallida.** Cada versión guarda el `bootId` del
proceso que la corre (`src/lib/voz/estado.ts`). Una versión "en_cola" o "procesando" con otro
`bootId` es huérfana: se marca fallida y deja de bloquear. Dos bugs evitados:

1. **Una huérfana bloquearía "Volver a unir" para siempre**, con el 409 de D17.
2. **Retomar sola volvería a gastar créditos** de un trabajo que nadie está mirando.

La cola de Vertex sí retoma, porque ahí el trabajo estaba pagado a medias. Acá se reintenta con un
clic.

**D13 — La API key vive solo en el server, por usuario con fallback compartido.**

- **Resolución:** `ELEVENLABS_API_KEY_<NOMBRE>` pisa a `ELEVENLABS_API_KEY`, con el mismo patrón que
  `PASSWORD_<NOMBRE>`.
- **Nunca sale del server:** ni en respuestas, ni en logs, ni en mensajes de error.
- **El `voice_id` del cliente se valida con `VOICE_ID_RE`** antes de armar la URL. Sin eso, un
  `../` entra al path del pedido a ElevenLabs con la key del server.

**D14 — Las favoritas van en su propio archivo, `<DATA_DIR>/voces-favoritas.json`, por usuario. No
van en `db.json`.**

- Son preferencias **por usuario**, no datos de un proyecto.
- Meterlas en `db.json` obliga a tocar `db.ts`, del que depende toda la app, por una lista de
  preferencias.
- El archivo usa la misma escritura atómica (tmp + rename) y el mismo singleton por `globalThis`.

**D15 — Sin SDK de ElevenLabs: `fetch` + `FormData` + `Blob` nativos.** Un SDK es una dependencia más
que viaja al build standalone, y el repo ya habla con Vertex por `fetch`. Son tres endpoints.

**D16 — `VOICE_PROVIDER=mock` por defecto**, con el mismo criterio que `PROVIDER_MODE`: el default no
gasta.

- **La conversión mock sube el tono un 25 % sin cambiar la duración** (verificado).
- **El mock lista 4 voces fijas.** Así todo el circuito se prueba sin key.

**D17 — "Volver a unir" usa el mismo `POST /api/projects/:id/stitch`, que ahora contesta 409 si hay
una conversión viva.** Volver a unir a mitad de una conversión cambia el archivo fuente mientras se
le está sacando el audio. La corrida igual chequea al final que el unido no haya cambiado, como
defensa en profundidad.

**D18 — Borrar el proyecto cancela su conversión antes de borrar la carpeta.** Sin eso, la corrida
sigue escribiendo en `<proyecto>/voz/_trabajo/`. `fsp.mkdir({ recursive: true })` recrea la carpeta
que se acaba de borrar y queda un proyecto fantasma en disco. La corrida además chequea que el
proyecto exista antes de cada escritura.

**D19 — Las versiones de voz entran al `.zip`, no al `manifest.json`.** El manifest es lo que la gente
copia a otras herramientas ("hay gente pegando esto en otras herramientas", dice la pantalla
Resultado). Cambiar su forma es cambiar un contrato externo. El zip es "todo lo que produje".

**D20 — Salida `mp3_44100_128` por defecto, configurable.** Es el único formato que todos los planes
aceptan con seguridad. WAV y PCM pueden requerir un plan superior; lo mide T00. Solo se aceptan
formatos `mp3_*` y `wav_*`: vienen con contenedor, así que ffmpeg los lee solo. `pcm_*` es audio
crudo sin cabecera, y leerlo obliga a adivinar la frecuencia.

**D21 — El `.mp4` de una versión se escribe como `.tmp.mp4` y se renombra al final.** Si el proceso
muere a mitad, nunca queda un archivo cortado con nombre de versión lista que la UI ofrezca descargar.

---

## 3. Arquitectura

```
src/lib/types.ts ───────── tipos compartidos server/cliente: VersionDeVoz, RecetaUnido, EstadoUnido,
      │                    AjustesDeVoz, VozResumen, VozFavorita, respuestas HTTP          (T01)
src/lib/config.ts ──────── config.voz + elevenLabsKeyFor(usuario)                          (T01)
src/lib/ffmpeg.ts ──────── + runFfmpegAsync (T01) · stitchProject arma la receta (T04)
src/lib/unido.ts ───────── estadoDelUnido / recetaVigente: ¿el unido sigue siendo el de los clips?  (T01)
src/lib/voz/
  ├── tipos.ts ─────────── VozProvider, ErrorDeVoz, VOICE_ID_RE (solo server)              (T01)
  ├── estado.ts ────────── BOOT_ID, esCorridaViva, corridaVivaDe                            (T01)
  ├── elevenlabs.ts ────── el cliente HTTP (listar, porIds, convertir, creditos)            (T02)
  ├── mock.ts ──────────── 4 voces fijas + conversión con ffmpeg                            (T02)
  ├── index.ts ─────────── getVozProvider(usuario), vozDisponible(usuario)                   (T02)
  ├── favoritas.ts ─────── <DATA_DIR>/voces-favoritas.json                                  (T02)
  ├── tramos.ts ────────── PURO: armarPiezas, ventanaDePrueba, estimar                     (T03)
  ├── audio.ts ─────────── los 7 pasos de ffmpeg de §9                                     (T03)
  └── corrida.ts ───────── la cola y el ciclo de vida de una versión                       (T03)

src/app/api/projects/[id]/stitch/route.ts   409 si hay corrida viva + persiste la receta   (T04)
src/app/api/projects/[id]/voz/route.ts      GET estado · POST convertir/probar/cancelar · DELETE versión (T05)
src/app/api/voces/route.ts                  GET lista de voces (+ créditos)                (T05)
src/app/api/voces/favoritas/route.ts        POST / DELETE favorita                         (T05)
src/app/api/projects/[id]/route.ts          DELETE cancela la corrida                      (T05)
src/app/api/projects/[id]/download/route.ts el zip incluye las versiones                   (T05)

src/components/CambiarVozDialog.tsx         el diálogo                                     (T06)
src/app/project/[id]/result/page.tsx        panel Voz, Volver a unir, reproductor por versión (T06)
src/lib/ui-tokens.ts                        + estadoDeVersionDeVoz                          (T06)
```

**La dirección de los imports es de un solo sentido.** `corrida.ts` **no importa** `index.ts`: recibe
el proveedor como parámetro, con el mismo patrón que `masivo.ts` recibe `enqueueProject`. Lo arma la
ruta, que es la que sabe qué usuario pidió. Eso es lo que deja escribir T02 y T03 en paralelo.

---

## 4. CONTRATO — tipos (`src/lib/types.ts`)

Todo lo que la UI lee va acá y no en `src/lib/voz/`: el cliente importa **tipos** de `types.ts` y
nunca de un módulo que trae `node:fs`.

```ts
/** Ajustes de la voz, en el rango 0..1. Se mapean 1:1 a `voice_settings` de ElevenLabs. */
export interface AjustesDeVoz {
  estabilidad: number;      // stability
  similitud: number;        // similarity_boost
  estilo: number;           // style
  realceHablante: boolean;  // use_speaker_boost
}

/** Un clip tal cual entró al unido. Ver §7. */
export interface ClipEnReceta {
  id: string;
  assetId: string;          // hoy no se usa: habilita "una voz por persona" sin volver a unir (D3)
  etiqueta: string;         // "IA" | "FILMAR_REAL"
  conDialogo: boolean;      // clip.dialogo.trim() !== "" al momento de unir
  file: string;             // path relativo, ej "clips/03_c3.mp4"
  mtimeMs: number;          // Math.trunc(stat.mtimeMs) ANTES de correr ffmpeg
  bytes: number;
  inicioSeg: number;        // dentro del unido
  finSeg: number;
}

export interface RecetaUnido {
  file: string;             // el unido, relativo: "<slug>.mp4"
  creadoEn: string;         // ISO. Identifica ESTE unido (las versiones lo guardan)
  duracionSeg: number;      // = finSeg del ultimo clip
  clips: ClipEnReceta[];    // en orden
}

/** Lo que la UI necesita saber del unido. */
export interface EstadoUnido {
  existe: boolean;
  file: string | null;
  conReceta: boolean;
  desactualizado: boolean;
  motivo: string | null;    // en castellano, listo para mostrar
  creadoEn: string | null;  // RecetaUnido.creadoEn, o null sin receta
}

export type EstadoVersionDeVoz =
  | "en_cola" | "procesando" | "lista" | "fallida" | "cancelada";

export interface VersionDeVoz {
  id: string;                               // randomUUID()
  voz: { id: string; nombre: string };      // nombre = alias o nombre de la voz AL CONVERTIR
  proveedor: "mock" | "elevenlabs";
  modelo: string | null;                    // el que devolvio el proveedor
  ajustes: AjustesDeVoz | null;             // null = los que la voz tiene guardados en ElevenLabs
  quitarRuido: boolean;
  incluirFilmados: boolean;
  prueba: boolean;
  estado: EstadoVersionDeVoz;
  progreso: { tramosListos: number; tramosTotal: number };
  segundosConvertidos: number;
  file: string | null;                      // relativo: "voz/<...>.mp4", solo con estado "lista"
  bytes: number | null;
  error: string | null;
  recetaCreadaEn: string;                   // RecetaUnido.creadoEn sobre la que se hizo
  bootId: string;                           // D12
  usuario: string;                          // quien la pidio
  creadoEn: string;
  actualizadoEn: string;
}

// En ProjectRecord, los dos OPCIONALES (cambio aditivo, mismo criterio que `owner?`):
//   recetaUnido?: RecetaUnido;
//   versionesVoz?: VersionDeVoz[];       // la mas nueva PRIMERO

/** Una voz como la muestra la UI, normalizada desde ElevenLabs o el mock. */
export interface VozResumen {
  id: string;
  nombre: string;
  categoria: string | null;                 // premade | cloned | generated | professional | ...
  etiquetas: Record<string, string>;        // labels tal cual: accent, gender, age, use_case...
  descripcion: string | null;
  previewUrl: string | null;                // SOLO https; cualquier otra cosa -> null
  esPropia: boolean;
}

export interface VozFavorita {
  voiceId: string;
  proveedor: "mock" | "elevenlabs";
  alias: string;                            // 1..60 caracteres
  ajustes: AjustesDeVoz | null;
  agregadaEn: string;
}

export interface VozEnLista extends VozResumen {
  favorita: VozFavorita | null;
  disponible: boolean;                      // false = favorita que ya no esta en la cuenta
}

export interface CreditosDeVoz {
  usados: number;
  limite: number;
  seRenuevaEn: string | null;               // ISO
  plan: string | null;
}

export interface EstimacionDeVoz {
  segundos: number;
  tramos: number;
  creditos: number;
  usd: number;
}

/** GET /api/projects/:id/voz */
export interface RespuestaEstadoVoz {
  proveedor: "mock" | "elevenlabs";
  disponible: boolean;
  motivoNoDisponible: string | null;
  unido: EstadoUnido;
  estimacion: {
    sinFilmados: EstimacionDeVoz;
    conFilmados: EstimacionDeVoz | null;    // null si no hay FILMAR_REAL con dialogo
    prueba: EstimacionDeVoz;
  } | null;                                 // null sin receta vigente
  filmadosConDialogo: number;
  versiones: VersionDeVoz[];                // la mas nueva primero
  activa: VersionDeVoz | null;
}

/** GET /api/voces */
export interface RespuestaVoces {
  proveedor: "mock" | "elevenlabs";
  voces: VozEnLista[];
  siguiente: string | null;
  creditos: CreditosDeVoz | null;
}
```

---

## 5. CONTRATO — configuración y variables de entorno

En `src/lib/config.ts`, un bloque `voz` dentro de `config` y una función suelta para la key:

```ts
voz: {
  proveedor: "mock" | "elevenlabs",   // VOICE_PROVIDER; cualquier otro valor -> "mock"
  elevenlabs: {
    baseUrl: string,                  // ELEVENLABS_BASE_URL, sin "/" final
    modelo: string,                   // ELEVENLABS_STS_MODEL
    formatoSalida: string,            // ELEVENLABS_OUTPUT_FORMAT; si no empieza con mp3_ o wav_ -> default (D20)
    timeoutMs: number,                // ELEVENLABS_TIMEOUT_MS
  },
  tramoMaxSeg: number,                // VOICE_CHUNK_MAX_SEC, acotado a 30..290
  pruebaSeg: number,                  // VOICE_PREVIEW_SEC, acotado a 5..60
  offsetMs: number,                   // VOICE_OFFSET_MS, acotado a 0..500
  facturacion: "por_minuto" | "proporcional",   // VOICE_BILLING
  precioPorMinUsd: number,            // PRICE_VOICE_PER_MIN_USD
}

/** "" si no hay ninguna. Lee process.env en CADA llamada, igual que authUsers(). */
export function elevenLabsKeyFor(usuario: string): string;
// = process.env[`ELEVENLABS_API_KEY_${usuario.toUpperCase()}`] || process.env.ELEVENLABS_API_KEY || ""
```

| Variable | Default | Qué hace |
|---|---|---|
| `VOICE_PROVIDER` | `mock` | `mock` o `elevenlabs` |
| `ELEVENLABS_API_KEY` | — | key compartida. **Solo en el server** |
| `ELEVENLABS_API_KEY_<NOMBRE>` | — | key de un usuario; pisa a la compartida |
| `ELEVENLABS_BASE_URL` | `https://api.elevenlabs.io` | para la residencia de datos en EU, si hiciera falta |
| `ELEVENLABS_STS_MODEL` | `eleven_multilingual_sts_v2` | modelo del Voice Changer |
| `ELEVENLABS_OUTPUT_FORMAT` | `mp3_44100_128` | D20 |
| `ELEVENLABS_TIMEOUT_MS` | `180000` | por pedido de conversión |
| `VOICE_CHUNK_MAX_SEC` | `270` | largo máximo de un tramo (D4) |
| `VOICE_PREVIEW_SEC` | `20` | largo de la prueba |
| `VOICE_OFFSET_MS` | `0` | recorte al inicio de cada salida, si T00 mide un corrimiento fijo |
| `VOICE_BILLING` | `por_minuto` | cómo estimar créditos. Default conservador: muestra el máximo |
| `PRICE_VOICE_PER_MIN_USD` | `0.12` | solo informativo |
| `VOICE_MOCK_DELAY_MS` | `0` | el mock espera esto por tramo. Solo para verificación: permite probar el 409 y el cancelar |

La cabecera de `.env.example` dice *"NO pongas API keys ni service accounts: la autenticacion es por
ADC"*. Pasa a decir que Vertex usa ADC y ElevenLabs una API key que va **solo** en
`.env.local` / `.env.production`.

---

## 6. CONTRATO — el proveedor de voz

### 6.1 La interfaz (`src/lib/voz/tipos.ts`, solo server)

```ts
import type { AjustesDeVoz, CreditosDeVoz, VozResumen } from "../types";

/** ElevenLabs usa ids alfanumericos de 20; el mock, "mock-<nombre>". Se valida ANTES de la URL (D13). */
export const VOICE_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

export type ListaDeVoces = "mias" | "predeterminadas";

export interface PaginaDeVoces { voces: VozResumen[]; siguiente: string | null }

export interface ConvertirInput {
  voiceId: string;
  wav: Uint8Array;               // WAV PCM s16le mono 44.1 kHz (lo arma audio.ts)
  ajustes: AjustesDeVoz | null;
  quitarRuido: boolean;
  signal?: AbortSignal;
}

export interface ConvertirResultado {
  bytes: Uint8Array;
  extension: "mp3" | "wav";      // D20
  modelo: string;
}

export interface VozProvider {
  readonly nombre: "mock" | "elevenlabs";
  listar(lista: ListaDeVoces, opts?: { q?: string; cursor?: string | null }): Promise<PaginaDeVoces>;
  /** Resuelve hasta 100 ids (para las favoritas). Los que no existen, NO vienen. */
  porIds(ids: string[]): Promise<VozResumen[]>;
  convertir(input: ConvertirInput): Promise<ConvertirResultado>;
  /** Best-effort: null si no se puede saber (key sin permiso de user_read, mock). */
  creditos(): Promise<CreditosDeVoz | null>;
}

export type CodigoErrorDeVoz =
  | "no_configurado" | "key_invalida" | "sin_permiso" | "sin_creditos"
  | "voz_inexistente" | "limite" | "red" | "timeout" | "validacion" | "otro";

export class ErrorDeVoz extends Error {
  codigo: CodigoErrorDeVoz;
  status: number | null;
  retryAfterMs?: number;
  // constructor(message, codigo, status = null, retryAfterMs?)
  /** true solo para "limite" | "red" | "timeout". */
  get reintentable(): boolean;
}
```

`src/lib/voz/index.ts` (T02):

```ts
/** Lanza ErrorDeVoz("no_configurado") si VOICE_PROVIDER=elevenlabs y el usuario no tiene key. */
export function getVozProvider(usuario: string): VozProvider;
export function vozDisponible(usuario: string): { disponible: boolean; motivo: string | null };
```

### 6.2 ElevenLabs (`src/lib/voz/elevenlabs.ts`)

Toda llamada lleva el header `xi-api-key`. **Es el único archivo del repo que escribe ese header.**

| Método | Llamada | Detalle |
|---|---|---|
| `listar("mias")` | `GET /v2/voices?voice_type=non-default&page_size=100&sort=created_at_unix&sort_direction=desc` | + `search=<q>`, `next_page_token=<cursor>`. `non-default` = todo lo de la cuenta que no es predeterminado |
| `listar("predeterminadas")` | `GET /v2/voices?voice_type=default&page_size=100&sort=name&sort_direction=asc` | idem |
| `porIds(ids)` | `GET /v2/voices?voice_ids=<id>&voice_ids=<id>…` | máx. 100 |
| `convertir` | `POST /v1/speech-to-speech/{voiceId}?output_format=<formatoSalida>` | multipart: `audio` (Blob `audio/wav`, `tramo.wav`), `model_id`, `remove_background_noise` (`"true"`/`"false"`), `voice_settings` (JSON, **solo si `ajustes` no es null**) |
| `creditos` | `GET /v1/user/subscription` | `usados = character_count`, `limite = character_limit`, `seRenuevaEn = next_character_count_reset_unix`, `plan = tier` |

- **Mapeo de ajustes:** `{ stability, similarity_boost, style, use_speaker_boost }`.
- **Normalización de voz:**
  - `voice_id` → `id`, `name` → `nombre`, `labels` → `etiquetas`.
  - `preview_url` → `previewUrl`, **solo si empieza con `https://`**.
  - `is_owner` → `esPropia`.
- **Timeout:** `AbortController` propio, combinado **a mano** con el `signal` de la corrida. No se usa
  `AbortSignal.any`, que requiere Node ≥ 20.3; `engines` dice ≥ 18.18.
- **Cache en memoria de 60 s** para `listar`, `porIds` y `creditos`, por (key, parámetros). No para
  `convertir`. La clave del cache usa un hash de la key, **nunca la key**.

**Mapeo de errores** (`detail.status` del JSON de error, si viene):

| HTTP | `detail.status` | `codigo` |
|---|---|---|
| 401 | `quota_exceeded` | `sin_creditos` |
| 401 | `missing_permissions` | `sin_permiso` |
| 401 | otro | `key_invalida` |
| 400 / 422 | — | `validacion` (con el `message` de ElevenLabs) |
| 404 | — | `voz_inexistente` |
| 429 | cualquiera | `limite`, con `retryAfterMs` del header `Retry-After` (reusar `parseRetryAfter` de `providers/types.ts`) |
| 5xx | — | `limite` (reintentable) |
| red / abort por timeout | — | `red` / `timeout` |

Los mensajes de error **nunca** incluyen la key ni los headers.

### 6.3 Mock (`src/lib/voz/mock.ts`)

- **Cuatro voces fijas:** `mock-grave`, `mock-aguda`, `mock-neutra`, `mock-radio`. `previewUrl: null`,
  `categoria: "premade"`, etiquetas en castellano. `listar("mias")` devuelve las dos primeras,
  `listar("predeterminadas")` las cuatro. `q` filtra por nombre.
- **`convertir`:**
  1. Escribe el WAV en un temporal.
  2. Aplica `asetrate=44100*1.25,aresample=44100,atempo=0.8`: tono +25 %, misma duración,
     verificado en §1.
  3. Devuelve `extension: "wav"`, `modelo: "mock"`.

  Usa `runFfmpegAsync` y respeta el `signal`. **Antes** de convertir espera `VOICE_MOCK_DELAY_MS`,
  y esa espera también es abortable.
- **`creditos()`** devuelve `null`.

### 6.4 Favoritas (`src/lib/voz/favoritas.ts`)

```ts
export function favoritasDe(usuario: string, proveedor: "mock" | "elevenlabs"): VozFavorita[];
export function guardarFavorita(
  usuario: string,
  proveedor: "mock" | "elevenlabs",
  f: { voiceId: string; alias?: string; ajustes?: AjustesDeVoz | null },
): VozFavorita[];                       // upsert por voiceId; devuelve la lista del usuario
export function quitarFavorita(usuario: string, proveedor: "mock" | "elevenlabs", voiceId: string): VozFavorita[];
```

- **Archivo:** `<DATA_DIR>/voces-favoritas.json`, con la forma
  `{ "version": 1, "porUsuario": { "<usuario>": VozFavorita[] } }`.
- **Escritura:** atómica (tmp + rename), con singleton por `globalThis`.
- **Si el archivo está roto, arranca vacío pero NO lo pisa**: lo renombra a `.roto-<ts>` antes de
  escribir. `db.ts` no hace esto, y un JSON roto ahí termina pisado por uno vacío.
- **Validaciones** (lanzan `ErrorDeVoz("validacion")`):
  - `voiceId` con `VOICE_ID_RE`;
  - `alias` 1..60 caracteres después de `trim()`; si falta, queda el `voiceId`, pero la UI siempre
    manda el nombre;
  - `ajustes` en 0..1;
  - máximo 50 por usuario.

---

## 7. CONTRATO — la receta del unido (`src/lib/unido.ts` y el stitch)

### 7.1 Cómo la arma el stitch (T04, `src/lib/ffmpeg.ts`)

`StitchResult` suma `receta?: RecetaUnido`. En `stitchProject`:

1. **Antes de correr ffmpeg**, por cada clip de `ordered`, `fs.statSync` → `mtimeMs`
   (`Math.trunc`) y `bytes`. Antes y no después: si un clip cambiara durante el stitch, la receta
   tiene que describir lo que se leyó.
2. `inicioSeg` y `finSeg` son acumulados de `clipMeta[i].duration`, que ya sale de `probeDuration`,
   o sea de la duración de formato (verificado en §1).
3. `conDialogo = Boolean(clip.dialogo?.trim())`, `assetId = clip.asset_id`,
   `etiqueta = clip.etiqueta`.
4. **Solo si `ffprobeOk`.** Sin ffprobe las duraciones son las del plan (4/6/8), la receta sería
   inexacta y no se devuelve. Sin receta, el cambio de voz dice que falta ffprobe.
5. `file = finalRel`, `creadoEn = new Date().toISOString()` **después** de que ffmpeg terminó OK.

El route handler (T04) persiste `projectsDb.update(id, { recetaUnido: result.receta })` **solo si
`result.ok && result.receta`**.

### 7.2 El estado del unido (T01, `src/lib/unido.ts`)

```ts
export function estadoDelUnido(project: ProjectRecord, jobs: JobRecord[]): EstadoUnido;
/** La receta si existe y NO esta desactualizada; si no, null. */
export function recetaVigente(project: ProjectRecord, jobs: JobRecord[]): RecetaUnido | null;
```

1. `buildManifest(project, jobs)`. Sin `final_video`, devuelve
   `{ existe: false, file: null, conReceta: false, desactualizado: false, motivo: null, creadoEn: null }`.
2. Sin `project.recetaUnido`, o con `recetaUnido.file !== final_video`, devuelve
   `conReceta: false` y el motivo *"Este video se unió antes del cambio de voz. Volvé a unir una vez
   para habilitarlo."*.
3. Si no, compara **en orden** los clips de la receta con los clips actuales **con archivo en disco**
   (el mismo filtro que usa `stitchProject`: `c.file && exists`, ordenados por `orden`). El
   **primer** caso que aplica da el motivo:

| Caso | Motivo |
|---|---|
| hay más clips actuales | "Hay N clip(s) nuevo(s) desde que se unió." |
| hay menos | "Se sacaron clips desde que se unió." |
| cambia el id en una posición | "Cambió el orden de los clips desde que se unió." |
| cambia el `file` | "El clip NN cambió de archivo después de unir." |
| el archivo no existe, o cambian `mtimeMs` o `bytes` | "El clip NN (<id>) se regeneró o reemplazó después de unir." |

`NN` es la posición con dos dígitos (`01`, `02`…), como en la pantalla.

**El módulo solo lee.** No escribe en la DB ni en disco: se llama en cada `GET /voz`, y un `save()`
acá correría en cada polling.

---

## 8. CONTRATO — el armado de piezas (`src/lib/voz/tramos.ts`, PURO)

**Solo `import type`.** Nada de `fs`, nada de `config`: todo entra por parámetro. Es lo que permite
probarlo con `node` directo (verificado en §1), y es lo único del módulo con aritmética no trivial.

```ts
import type { ClipEnReceta, EstimacionDeVoz, RecetaUnido } from "../types";

export interface Pieza {
  tipo: "convertir" | "conservar";
  inicioSeg: number;
  finSeg: number | null;     // null = hasta el final del audio (absorbe el relleno del AAC)
  clipIds: string[];
}

export function debeConvertirse(clip: ClipEnReceta, incluirFilmados: boolean): boolean;
// = clip.conDialogo && (clip.etiqueta !== "FILMAR_REAL" || incluirFilmados)

export function armarPiezas(
  receta: RecetaUnido,
  opts: { incluirFilmados: boolean; maxSeg: number; ventana?: { inicioSeg: number; finSeg: number } },
): Pieza[];

/** Arranca en el primer clip que se convierte. null si no hay ninguno. */
export function ventanaDePrueba(
  receta: RecetaUnido,
  opts: { incluirFilmados: boolean; pruebaSeg: number },
): { inicioSeg: number; finSeg: number } | null;
// = { inicioSeg: c.inicioSeg, finSeg: Math.min(c.inicioSeg + pruebaSeg, receta.duracionSeg) }

export function estimar(
  piezas: Pieza[],
  opts: { facturacion: "por_minuto" | "proporcional"; precioPorMinUsd: number; duracionTotalSeg: number },
): EstimacionDeVoz;
```

**Reglas de `armarPiezas`:**

1. Las piezas son **contiguas y cubren todo**: la primera empieza en 0 (o en `ventana.inicioSeg`), el
   fin de una es el inicio de la siguiente, sin huecos ni solapes.
2. **Clips consecutivos del mismo tipo se juntan.** Los que se convierten, mientras la pieza no pase de
   `maxSeg`. Los que se conservan, sin límite.
3. **Un clip que se convierte y dura más de `maxSeg` por sí solo** (no pasa en esta app) se parte en
   pedazos de `maxSeg`. Es el único corte a mitad de clip.
4. **Sin ventana, la última pieza tiene `finSeg: null`.** Con ventana, todo se recorta a
   `[inicio, fin]`, se descartan las piezas vacías, y la última termina en `ventana.finSeg`.
5. **`clipIds` lista los clips que toca cada pieza**, incluso parcialmente.

**`estimar`:**

- `segundos` suma las piezas que se convierten. Para `finSeg: null` usa `duracionTotalSeg`.
- `tramos` es la cantidad de piezas que se convierten.
- `creditos` depende de la facturación:
  - `"por_minuto"`: `Σ ceil(dur/60) × 1000`;
  - `"proporcional"`: `ceil(segundos / 60 × 1000)`.
- `usd = creditos / 1000 × precioPorMinUsd`, redondeado a 2 decimales.

**Ejemplos: son los chequeos B15-B18 de `_verificacion-voz.sh`, que llama a `armarPiezas` de verdad.**
Receta de 4 clips:

- c1 `[0, 8]` IA con diálogo
- c2 `[8, 16.06]` IA con diálogo
- c3 `[16.06, 22.06]` `FILMAR_REAL` con diálogo
- c4 `[22.06, 30.06]` IA sin diálogo

Notación: `C` = convertir, `K` = conservar.

| Llamada | Resultado |
|---|---|
| `incluirFilmados:false, maxSeg:270` | `C 0-16.06 [c1,c2]` · `K 16.06-fin [c3,c4]` |
| `incluirFilmados:true, maxSeg:270` | `C 0-22.06 [c1,c2,c3]` · `K 22.06-fin [c4]` |
| `incluirFilmados:false, maxSeg:10` | `C 0-8 [c1]` · `C 8-16.06 [c2]` · `K 16.06-fin [c3,c4]` |
| `ventanaDePrueba(pruebaSeg:20)` y después `armarPiezas` con esa ventana | ventana `0-20` → `C 0-16.06 [c1,c2]` · `K 16.06-20 [c3]` |

---

## 9. Motor de audio (`src/lib/voz/audio.ts`) — los comandos, verificados en §1

Todos van por `runFfmpegAsync` (que respeta el límite de cores) y reciben el `signal` de la corrida.
Los cortes se hacen **por muestra**, a 48 kHz: `n = Math.round(seg × 48000)`. El fin de una pieza es
**la misma muestra** que el inicio de la siguiente.

| Paso | Comando (args de ffmpeg) |
|---|---|
| 1. Audio completo | `-y -i <unido> -vn -ac 2 -ar 48000 -c:a pcm_s16le completo.wav` → `N_total` con `ffprobe -show_entries stream=duration_ts` |
| 2. Tramo para el proveedor | `-y -i completo.wav -af atrim=start_sample=<a>:end_sample=<b>,asetpts=N/SR/TB -ac 1 -ar 44100 -c:a pcm_s16le tramo_<i>_in.wav` |
| 3. Normalizar la salida | `-y -i tramo_<i>_out.<mp3\|wav> -af <offset>aresample=48000,<ajuste>apad=whole_len=<n>,atrim=end_sample=<n> -ac 2 -c:a pcm_s16le pieza_<i>.wav` |
| 4. Pieza conservada | `-y -i completo.wav -af atrim=start_sample=<a>[:end_sample=<b>],asetpts=N/SR/TB -c:a pcm_s16le pieza_<i>.wav` |
| 5. Concatenar | `-y -f concat -safe 0 -i lista.txt -c copy nuevo.wav`, y verificar `duration_ts == N_total` (si no, falla) |
| 6. Remux (completa) | `-y -i <unido> -i nuevo.wav -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 192k -movflags +faststart <salida>.tmp.mp4` |
| 7. Recorte (prueba) | `-y -ss <inicio> -t <dur> -i <unido> -i nuevo.wav -map 0:v:0 -map 1:a:0 -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart <salida>.tmp.mp4` |

**Los huecos del paso 3:**

- **`<offset>`** es `atrim=start=<offsetMs/1000>,asetpts=N/SR/TB,` si `VOICE_OFFSET_MS > 0`; si
  no, nada.
- **`<ajuste>`** depende de la diferencia `Δ` entre la salida y el tramo:
  - |Δ| ≤ 50 ms: nada.
  - 50 ms < |Δ| ≤ 5 %: `atempo=<dur_salida/dur_tramo>,` (conserva el tono; D5).
  - |Δ| > 5 %: el tramo falla con *"ElevenLabs devolvió un audio de duración inesperada"*.

  La duración de la salida sale de ffprobe, después del offset.

**En la prueba, `nuevo.wav` es solo la ventana:** los pasos 1 a 5 corren con las piezas de la ventana,
contadas desde `ventana.inicioSeg`. El video se re-encodea porque `-ss` con `-c:v copy` corta en el
keyframe anterior y el audio quedaría corrido. Son 20 s: tarda pocos segundos.

**Carpeta de trabajo:** `<proyecto>/voz/_trabajo/<versionId>/`. Se borra en un `finally`: éxito,
falla o cancelación.

**Nombre de la salida:** `voz/<slugProyecto>__voz-<slugVoz>-<id6>.mp4`, y la prueba
`voz/<slugProyecto>__prueba-voz-<slugVoz>-<id6>.mp4`. `id6` son los primeros 6 caracteres del id de
la versión. Nombre legible porque el zip usa `-j` (junk paths) y en el zip solo queda el nombre del
archivo. Los slugs salen de `slugify` de `storage.ts`.

---

## 10. La corrida (`src/lib/voz/corrida.ts`)

### 10.1 Contrato

```ts
export interface OpcionesDeCorrida {
  voz: { id: string; nombre: string };
  ajustes: AjustesDeVoz | null;
  quitarRuido: boolean;
  incluirFilmados: boolean;
  prueba: boolean;
}

export type CodigoErrorDeCorrida =
  | "sin_unido" | "sin_receta" | "desactualizado" | "ocupado" | "nada_para_convertir" | "sin_ffmpeg";

export class ErrorDeCorrida extends Error { codigo: CodigoErrorDeCorrida }

/** Valida SINCRONICO (lanza ErrorDeCorrida), persiste la version "en_cola" y la encola. */
export function iniciarCorrida(args: {
  projectId: string;
  usuario: string;
  opciones: OpcionesDeCorrida;
  proveedor: VozProvider;          // inyectado por la ruta (§3)
}): VersionDeVoz;

/** true si habia una viva para ese proyecto (en cola o procesando). Idempotente. */
export function cancelarCorrida(projectId: string): boolean;

/** Una vez por proceso: marca "fallida" las huerfanas (D12) y borra voz/_trabajo/ viejos. */
export function reconciliarTrasReinicio(): void;
```

### 10.2 Reglas

1. **Validación antes de crear nada:**
   - sin ffmpeg/ffprobe → `sin_ffmpeg`;
   - sin unido → `sin_unido`;
   - sin receta → `sin_receta`;
   - receta desactualizada → `desactualizado`, con el motivo de `estadoDelUnido`;
   - `corridaVivaDe(project)` → `ocupado`;
   - cero piezas que convertir → `nada_para_convertir`.
2. **Cola global en memoria** (singleton en `globalThis`, como `queue.ts`): una versión
   **procesando** a la vez en toda la app. Las demás, `en_cola`, en orden de llegada.
3. **Persistencia: siempre leer y después escribir.** `actualizarVersion(projectId, versionId, patch)`
   relee el proyecto con `projectsDb.get` y reescribe **solo** `versionesVoz`. Nunca guarda una copia
   vieja del `ProjectRecord`: la cola de Vertex también actualiza el proyecto (`status`), y pisarlo con
   una copia vieja le borra cambios. **Si el proyecto ya no existe, la corrida se aborta sin escribir
   nada** (D18).
4. **Progreso:** `tramosTotal` se fija al armar las piezas, y `tramosListos` sube después de
   normalizar cada tramo. Son pocas escrituras (una por tramo).
5. **Reintentos:** por tramo, hasta **4** para `ErrorDeVoz.reintentable`. La espera es
   `retryAfterMs`, o si no viene, `min(60 s, 5 s × 2^intento)` con jitter. Los demás errores cortan la
   corrida al toque.
6. **Cancelar:**
   - aborta el `AbortController` de la corrida: corta el `fetch` y mata el ffmpeg en curso;
   - marca `cancelada`;
   - borra la carpeta de trabajo.

   Si estaba `en_cola`, solo la saca de la cola y la marca.
7. **Antes del `rename` final**, la corrida verifica dos cosas:
   - que `recetaVigente` siga devolviendo la **misma** receta (mismo `creadoEn`);
   - que el `mtimeMs` del unido no haya cambiado desde el arranque.

   Si algo cambió, falla con *"El video unido cambió mientras se convertía."* (D17).
8. **Log del proyecto** (`logEvent` de `jobs/pipeline.ts`), cuatro momentos:
   - **inicio:** `info`, *"Voz: convirtiendo a <nombre> (N tramos, Xs)"*;
   - **fin:** `success`, *"Voz lista: <file>"*;
   - **falla:** `error`, con el mensaje de §14;
   - **cancelación:** `warn`.

   Nunca la key.
9. **`reconciliarTrasReinicio`** lo llaman las rutas de `/voz` al entrar. Es un guard de una vez por
   proceso, como `recuperarTrasReinicio`. No se llama a nivel de módulo, porque Next evalúa módulos
   durante el build y un `next build` no tiene que tocar la base de producción.
10. **Nada de `spawnSync` largo en este módulo.** Solo `ffprobe` puntuales, que tardan milisegundos.

### 10.3 Estados

```
             iniciarCorrida
                  │
                  ▼
  ┌──────────► en_cola ──cancelar──► cancelada
  │               │ turno
  │               ▼
  │          procesando ──cancelar──► cancelada
  │               │
  │        ┌──────┴──────┐
  │        ▼             ▼
  │      lista        fallida ◄── reinicio del server (bootId distinto, D12)
  │                      │
  └── "Reintentar" ──────┘   (crea una versión NUEVA con las mismas opciones)
```

---

## 11. CONTRATO — API HTTP

Todas las rutas son `runtime = "nodejs"` y `dynamic = "force-dynamic"`. Todas contestan
`{ error: string, codigo?: string }` en error, con los helpers de `@/lib/http`.

### `GET /api/projects/:id/voz` → 200 `RespuestaEstadoVoz`

- Sin `requireProjectOwner` → 401 o 404 del helper.
- Llama a `reconciliarTrasReinicio()` antes de armar la respuesta.
- `estimacion` es null si no hay receta vigente. Si hay, se calcula con `armarPiezas` + `estimar`,
  usando `config.voz`, en tres variantes: sin filmados, con filmados y la ventana de prueba.

### `POST /api/projects/:id/voz`

```ts
// cuerpo
| { accion: "convertir" | "probar";
    voz: { id: string; nombre: string };       // id con VOICE_ID_RE; nombre 1..80
    ajustes?: AjustesDeVoz | null;             // cada numero en 0..1
    quitarRuido?: boolean;                     // default true
    incluirFilmados?: boolean }                // default false
| { accion: "cancelar" }
```

| Caso | Respuesta |
|---|---|
| convertir / probar OK | **202** `{ version: VersionDeVoz }` |
| cancelar | 200 `{ cancelada: boolean }` |
| cuerpo inválido | 400 |
| `ErrorDeCorrida` `sin_unido` / `sin_receta` / `desactualizado` / `nada_para_convertir` / `sin_ffmpeg` | 400 `{ error, codigo }` |
| `ErrorDeCorrida` `ocupado` | **409** `{ error, codigo: "ocupado" }` |
| `ErrorDeVoz` `no_configurado` | **503** `{ error, codigo: "no_configurado" }` |

### `DELETE /api/projects/:id/voz?version=<id>` → 200 `{ borrada: true }`

- 404 si la versión no existe en ese proyecto.
- **409 si la versión está viva**: primero se cancela.
- Borra el archivo (`removeRel`) y el registro.

### `GET /api/voces?lista=favoritas|mias|predeterminadas&q=&cursor=` → 200 `RespuestaVoces`

- Sin sesión → 401. Con `lista` inválida → 400. `no_configurado` → 503. Otro `ErrorDeVoz` → 502,
  con el mensaje de §14.
- **`favoritas`:**
  1. Toma las favoritas del usuario para el proveedor actual.
  2. Las resuelve con `porIds`.
  3. Arma `VozEnLista`. Las que ElevenLabs no devuelve van con `disponible: false`, el alias como
     nombre y la descripción *"Ya no está en tu cuenta de ElevenLabs"*.

  `siguiente` es `null`.
- **`mias` / `predeterminadas`:** `listar` del proveedor, y a cada voz se le pega su `favorita` si la
  hay.
- `creditos` es best-effort: si falla, `null`, sin fallar la respuesta.

### `POST /api/voces/favoritas` → 200 `{ favoritas: VozFavorita[] }`

Cuerpo `{ voiceId, alias?, ajustes? }`. Sin sesión → 401. Validación de §6.4 → 400.

### `DELETE /api/voces/favoritas?voiceId=<id>` → 200 `{ favoritas: VozFavorita[] }`

### Cambios en rutas existentes

| Ruta | Cambio |
|---|---|
| `POST /api/projects/:id/stitch` | Si `corridaVivaDe(project)`: **409** `{ ok: false, reason: "Hay un cambio de voz en curso en este proyecto. Esperá a que termine o cancelalo." }`. Si el stitch sale OK con receta, la persiste en `recetaUnido`. El resto de la respuesta no cambia (la UI lee `ok`, `finalPath`, `reason`) |
| `DELETE /api/projects/:id` | `cancelarCorrida(project.id)` **antes** de `removeProjectDir` (D18) |
| `GET /api/projects/:id/download` | Si se mandan videos, agrega las versiones con `estado === "lista"`, `!prueba` y archivo en disco (D19) |

---

## 12. UI

### 12.1 Resultado (`src/app/project/[id]/result/page.tsx`)

**Solo en `VideoFinal`** (cuando hay unido). `SinVideoFinal` no cambia, salvo un detalle de
`handleStitch` (abajo).

```
┌───────────────┐  Video final · piloto_vsl.mp4 · 11m 20s        [Volver a unir]
│               │  ⚠ Los clips cambiaron desde que se unió: el clip 03 se regeneró…   (si aplica)
│   <video>     │  [Descargar video final] [Todo (zip)] [JSON de los videos]
│  (la versión  │  ── Voz ──────────────────────────────────────── [Cambiar voz]
│  elegida)     │  ● Original · unido 25/9 14:02                          Ver
│               │  ○ Natalia VSL · Lista · 11m 20s · 214 MB     Ver  Descargar  Borrar
│               │  ○ Prueba 20 s · Mateo · Lista                          Ver  Borrar
│               │  ◌ Convirtiendo a Lucía · tramo 2 de 3  ▓▓▓▓░░         Cancelar
│               │  ✕ Falló · Lucía · Sin créditos en ElevenLabs…   Reintentar  Borrar
│               │  ── Carpeta de salida ──  …  ── Clips ──  …  ── JSON ── …
└───────────────┘
```

- **Estado:**
  - `GET /api/projects/:id/voz` al montar y después de cada acción.
  - **Polling cada 2 s mientras `activa !== null`**; se corta cuando queda en null.
  - El `setInterval` se limpia al desmontar.
- **Reproductor:** muestra la versión elegida (`Ver`). Por defecto, el original. Cuando una versión
  pasa a `lista` mientras la pantalla está abierta, queda elegida sola y se anuncia por `aria-live`:
  *"Lista la versión con la voz <nombre>"*.
- **"Descargar"** de una versión: `/api/files/<id>/<file>?dl=1&name=<slugProyecto>__voz-<slugVoz>.mp4`.
- **"Borrar"** usa `Confirmar` (peligroso).
- **"Reintentar" y "Rehacer con esta voz"** hacen `POST` con las mismas opciones de esa versión.
- **Versión desactualizada:** `version.recetaCreadaEn !== voz.unido.creadoEn` → `Badge`
  tone=`attention` *"Hecha sobre un unido anterior"* + "Rehacer con esta voz".
- **"Volver a unir":**
  - Pasa por `Confirmar` con detalle: *"Se vuelve a generar <file> con los clips actuales. Tarda
    ~1 s por segundo de video (~Xm). Las versiones con otra voz se conservan."*
  - Llama al mismo `handleStitch`.
  - Queda deshabilitado mientras `activa` (con `title` explicando).
- **Unido desactualizado o sin receta:** "Cambiar voz" deshabilitado, con el motivo visible debajo
  (no solo en `title`: un `title` no se ve en touch ni en teclado).
- **`handleStitch` hoy** (`page.tsx:209`) hace `res.json().catch(() => ({}))` y, con el 524 de
  Cloudflare, muestra "No se pudo unir." aunque el server siga uniendo. Pasa a detectar la respuesta
  no-JSON y decir: *"El servidor sigue uniendo: los videos largos tardan más de lo que espera el
  proxy. Recargá en unos minutos."* (P-04).
- **Estados de versión:** siempre con `Badge` + `estadoDeVersionDeVoz()` de `ui-tokens`. Nada de
  `switch` local (regla 1 de §6 del plan de rediseño).

### 12.2 El diálogo (`src/components/CambiarVozDialog.tsx`)

```ts
export function CambiarVozDialog(props: {
  abierto: boolean;
  onCambio: (v: boolean) => void;
  proyectoId: string;
  estado: RespuestaEstadoVoz;              // estimaciones, filmados, proveedor, unido
  preseleccion?: VersionDeVoz | null;      // "Reintentar" / "Rehacer": arranca con esas opciones
  onIniciada: (v: VersionDeVoz) => void;   // la pagina refresca y empieza el polling
}): JSX.Element;
```

- **`DialogContent`** con `className="w-[min(42rem,calc(100vw-2rem))]"`. El ancho de 28 rem de la
  primitiva no alcanza para la lista. Título *"Cambiar la voz del video"*. Descripción *"Todo el
  diálogo pasa a la voz que elijas. El video no se toca y el original queda como está."*
- **Listas:**
  - `Segmented`: Favoritas · Mis voces · Predeterminadas. Arranca en Favoritas si hay alguna; si no,
    en Mis voces.
  - `Input` con label *"Buscar voz"*, debounce de 300 ms, que manda `q`. En Favoritas filtra del lado
    del cliente.
- **Filas de voz:**
  - Son `<input type="radio" name="voz">` nativos dentro de un `<label>`: las flechas del teclado
    funcionan solas.
  - Cada fila: nombre (o alias), etiquetas en `fg-dim`, botón **Escuchar** y botón **Favorita**
    (`aria-pressed`).
  - La lista scrollea adentro (`max-h-[45vh] overflow-y-auto`), con "Cargar más" si hay
    `siguiente`.
  - **Escuchar:** un único `<audio preload="none">` para todo el diálogo; tocar otra voz corta la
    anterior. Sin `previewUrl`, el botón queda deshabilitado con *"Sin muestra"*.
- **Favoritas:**
  - En la pestaña Favoritas, cada fila tiene "Editar": alias + "Guardar", inline.
  - Si la voz elegida es favorita y los ajustes cambiaron, aparece "Guardar ajustes en la favorita".
- **Ajustes** (sección colapsable *"Ajustes de la voz"*):
  - Tres `<input type="range" min=0 max=1 step=0.05>`, con `label` y el valor en `font-mono tnum` al
    lado, y una casilla *"Realce del hablante"*.
  - "Usar los de la voz" los vuelve a `null`.
  - Arrancan con los de la favorita, si tiene.
- **Opciones:**
  - `ToggleCard` *"Quitar ruido de fondo"* (on), hint *"Mejor conversión; se pierde el sonido
    ambiente de los clips que se convierten."*
  - `ToggleCard` *"Incluir clips filmados (N)"* (off), **solo si `filmadosConDialogo > 0`**.
- **Costo:**
  - *"Se convierten 11m 20s de audio en 3 tramos · ~12.000 créditos (~US$1,44)"*, con la estimación
    que corresponda al interruptor de filmados.
  - Debajo, *"Te quedan 87.400 créditos"* si `creditos` no es null.
  - En mock: *"Modo mock: no gasta créditos."*
- **Botones:**
  - "Probar 20 s" (`secondary`) y "Cambiar la voz de todo el video" (`primary`, con `loading`).
  - Los dos deshabilitados sin voz elegida o con `!estado.disponible`. Con `!disponible`, se
    muestra `motivoNoDisponible`.
- **Errores:**
  - Del listado: arriba de la lista, `role="alert"`, con "Reintentar".
  - Del `POST`: dentro del diálogo, sin cerrarlo.
- **Tokens y primitivas:** nada de colores literales. Nada de `rounded-full` salvo el punto de
  estado. `label` en todo campo. Foco visible.

---

## 13. Seguridad y privacidad

| Riesgo | Mitigación |
|---|---|
| La key llega al navegador o a un log | Solo `config.ts` la lee y solo `elevenlabs.ts` la manda. Chequeo A2 de `_verificacion-voz.sh`: ningún otro archivo de `src/` menciona `xi-api-key` ni `ELEVENLABS_API_KEY`. Los errores nunca copian headers |
| El `voice_id` del cliente cambia el path del pedido | `VOICE_ID_RE` en la ruta **y** en `elevenlabs.ts` (defensa doble, porque la ruta puede cambiar) |
| Ver o convertir un proyecto ajeno | `requireProjectOwner` en `/voz`. Chequeo A10: toda ruta bajo `projects/[id]/` lo usa |
| Favoritas ajenas | La clave es `sessionUser()`. El usuario **nunca** sale del body |
| `previewUrl` con un esquema raro | Solo `https://`; cualquier otra cosa → `null` |
| Disco lleno por versiones | Cada versión muestra su peso. Borrar es un clic. Las carpetas de trabajo se borran en `finally` |
| Privacidad del audio | El audio con diálogo sale hacia ElevenLabs y queda en su historial (`enable_logging` en su default: la retención cero es solo Enterprise). Se documenta en el README |
| Una corrida huérfana que bloquea | `bootId` (D12) |

---

## 14. Errores → mensajes

| Origen | Mensaje (se guarda en `VersionDeVoz.error` o sale en la respuesta HTTP) |
|---|---|
| `no_configurado` | "El cambio de voz no está configurado: falta ELEVENLABS_API_KEY en el server." |
| `key_invalida` | "ElevenLabs rechazó la API key. Revisá ELEVENLABS_API_KEY en el server." |
| `sin_permiso` | "La API key de ElevenLabs no tiene permiso para esto. Creala con Speech to Speech y Voices (lectura)." |
| `sin_creditos` | "No quedan créditos en ElevenLabs. Cargá créditos o esperá a que se renueve el plan." |
| `voz_inexistente` | "Esa voz ya no existe en tu cuenta de ElevenLabs." |
| `limite` (agotados los reintentos) | "ElevenLabs está saturado. Probá de nuevo en unos minutos." |
| `red` / `timeout` | "No se pudo hablar con ElevenLabs (red o tiempo de espera)." |
| `validacion` | "ElevenLabs rechazó el pedido: <message>" |
| ffmpeg | "ffmpeg falló en <paso>: <últimos 300 caracteres de stderr>" |
| duración fuera del 5 % | "ElevenLabs devolvió un audio de duración inesperada (tramo N)." |
| el unido cambió | "El video unido cambió mientras se convertía." |
| reinicio | "El server se reinició mientras se convertía. Volvé a intentarlo." |
| `sin_receta` | "Este video se unió antes del cambio de voz. Volvé a unir una vez para habilitarlo." |
| `desactualizado` | el `motivo` de `estadoDelUnido` + " Volvé a unir antes de cambiar la voz." |
| `ocupado` | "Ya hay un cambio de voz en curso en este proyecto." |
| `nada_para_convertir` | "No hay clips con diálogo para convertir." (+ " Probá incluir los clips filmados." si hay filmados) |
| `sin_ffmpeg` | "Falta ffmpeg o ffprobe en el server." |

---

## 15. Riesgos y mitigaciones

| Riesgo | Probabilidad | Mitigación |
|---|---|---|
| ElevenLabs no respeta los tiempos | Baja (su doc dice que conserva la performance) | D5 absorbe hasta el 5 %. **T00 lo mide antes de escribir T03** |
| Corrimiento fijo al inicio de la salida (relleno del mp3) | Media | `VOICE_OFFSET_MS`, calibrado por T00 |
| Salto de volumen entre tramos convertidos y conservados | Media | P-05. Se ve en el QA de T08 |
| Unir o volver a unir un VSL largo pasa los 100 s de Cloudflare | Alta en VSL (preexistente) | Mensaje honesto en la UI; el stitch asíncrono queda propuesto como módulo siguiente (P-04) |
| El plan free no deja usar voces de la Voice Library por API | Media | El error cae en `validacion` o `sin_permiso` con el mensaje de ElevenLabs. T00 lo anota (P-06) |
| Dos usuarios convierten a la vez | Baja | Cola global: el segundo espera "en cola" |

---

## 16. Lo que mide el spike (T00) y cómo cambia el diseño

| Medición | Si da… | Entonces |
|---|---|---|
| Δ duración salida/entrada en 20 s, 60 s y 270 s | ≤ 50 ms | D5 tal cual |
| | entre 50 ms y 5 % | D5 tal cual (el `atempo` lo corrige) y anotar los valores |
| | > 5 % | **Parar.** El enfoque de piezas contiguas no sirve y hay que rediseñar §8-§9 |
| Corrimiento del primer ataque de voz (entrada contra salida) | fijo, > 15 ms | Setear `VOICE_OFFSET_MS` en producción (T08) |
| Créditos descontados por un pedido de 20 s | ~333 | `VOICE_BILLING=proporcional` |
| | 1.000 | `por_minuto` (el default ya es ese) |
| `output_format=wav_44100` | lo acepta | Opcional: `ELEVENLABS_OUTPUT_FORMAT=wav_44100` (sin pérdida entre pasos) |
| | 403 por plan | Queda `mp3_44100_128` |
| `GET /v1/models` con `can_do_voice_conversion` | hay uno más nuevo que `eleven_multilingual_sts_v2` | Anotarlo en P-02. **No se cambia sin escuchar los dos** |
| Latencia de un tramo de 270 s | < 150 s | `ELEVENLABS_TIMEOUT_MS=180000` alcanza |
| | ≥ 150 s | Subirlo |
| `remove_background_noise` on y off, sobre el mismo audio de Veo | — | Los dos archivos quedan para que el usuario escuche. Define el default del interruptor |

---

## 17. Preguntas abiertas

Si aparece una decisión que este documento no resuelve, **se anota acá en lugar de decidirla en el
código**. Si bloquea, la task se detiene y no sigue con suposiciones.

### P-01 — ¿ElevenLabs cobra por segundo o redondea al minuto por pedido?
- **Estado (T00, 2026-09-25):** sin medir. La key de prueba no tiene `user_read`. Se confirma en T08
  mirando el consumo en el panel de ElevenLabs.
- **Task:** T00, con la confirmación en T08
- **Sección:** §8 (`estimar`), D4
- **Qué falta:** medir `character_count` antes y después de un pedido de 20 s.
- **Bloquea:** no. El default `por_minuto` muestra el máximo posible.

### P-02 — ¿`eleven_multilingual_sts_v2` sigue siendo el mejor modelo de voice changer?
- **Estado (T00, 2026-09-25):** el modelo funciona: los 4 pedidos del spike lo usaron. La lista de modelos
  no se pudo leer (la key no tiene `models_read`).
- **Task:** T00
- **Qué falta:** listar `GET /v1/models` y ver cuáles tienen `can_do_voice_conversion`.
- **Bloquea:** no. Es una variable de entorno.

### P-03 — Formato de salida según el plan del usuario
- **Resuelto (T00, 2026-09-25):** `wav_44100` → 403 `output_format_not_allowed` ("only available on the
  Pro tier and above"). Queda `mp3_44100_128`.
- **Task:** T00
- **Qué falta:** ¿el plan acepta `wav_44100`?
- **Bloquea:** no. `mp3_44100_128` anda en todos.

### P-04 — Unir un VSL largo pasa los 100 s de Cloudflare (preexistente, no lo introduce este módulo)
- **Task:** ninguna en v1
- **Sección:** §12.1
- **Qué pasa hoy:** "Unir en un video" en un VSL de 95 clips tarda unos 13 min, `spawnSync`
  bloquea la app, y el navegador recibe un 524 aunque el server termine bien. "Volver a unir" hereda
  exactamente lo mismo.
- **Qué se hace en v1:** el mensaje honesto de §12.1.
- **Propuesta para después:** pasar el stitch a la misma cola asíncrona de `src/lib/voz/corrida.ts`
  (con `runFfmpegAsync` ya existe todo lo necesario).
- **Bloquea:** no.

### P-05 — Salto de volumen entre lo convertido y lo conservado
- **Task:** T08 (QA)
- **Qué falta:** escuchar un proyecto real con `FILMAR_REAL` o clips sin diálogo en el medio. Si se
  nota, agregar `loudnorm` por pieza en un cambio aparte.
- **Bloquea:** no.

### P-06 — Voces de la Voice Library en planes gratuitos
- **Task:** T00 / T08
- **Qué falta:** ver si el plan del usuario deja convertir con una voz agregada desde la Voice
  Library.
- **Bloquea:** no. El error se muestra con el mensaje de ElevenLabs.

### P-07 — ElevenLabs contesta 403 y la tabla de §6.2 no lo mapea
- **Task:** T00 (hallazgo)
- **Sección:** §6.2 (mapeo de errores)
- **Qué pasó:** `output_format` fuera del plan → 403 con `detail.status = output_format_not_allowed`.
  Con la tabla actual cae en `otro`. Con el default `mp3_44100_128` no pasa; solo si alguien setea un
  `ELEVENLABS_OUTPUT_FORMAT` que el plan no tiene.
- **Propuesta:** mapear 403 a `sin_permiso` o `validacion` con el `message` de ElevenLabs.
- **Bloquea:** no.
