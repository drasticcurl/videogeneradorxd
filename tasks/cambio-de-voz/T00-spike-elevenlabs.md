# T00 — Spike: medir ElevenLabs con audio real de Veo

- **Depende de:** una API key de ElevenLabs y un video unido real (con audio de Veo)
- **Bloquea:** nada formalmente. **Recomendada antes de T03** (ver `03-TASKS.md` §2)
- **Se puede correr en paralelo con:** T01, y con cualquier otra: no toca `src/`
- **Archivos que este task puede tocar:** `tasks/cambio-de-voz/_spike-elevenlabs.mjs` (nuevo),
  `tasks/cambio-de-voz/_spike-resultados.md` (nuevo). **Nada de `src/`.**
- **Costo:** unos 6-7 minutos de audio convertidos, ~7.000 créditos (~US$0,85).

Leé `02-DISENO.md` completo. Tu contrato es **§16**: qué medir y qué decisión sale de cada número.

---

## 1. Objetivo

Reemplazar supuestos por números antes de escribir el motor. Cuando termines,
`_spike-resultados.md` responde, con datos:

1. ¿Cuánto difiere la duración de la salida respecto de la entrada, en 20 s, 60 s y 270 s? ¿Hay un
   corrimiento fijo al principio?
2. ¿Un pedido de 20 s descuenta ~333 créditos (proporcional) o 1.000 (redondeo al minuto)?
3. ¿El plan acepta `output_format=wav_44100`?
4. ¿Qué modelos tienen `can_do_voice_conversion`? ¿Sigue estando `eleven_multilingual_sts_v2`?
5. ¿Cuánto tarda un tramo de 270 s?
6. ¿Cómo suena con y sin `remove_background_noise`? Los dos archivos quedan para que el usuario
   escuche.
7. ¿Qué devuelve un `voice_id` inexistente (status y cuerpo)? Es para el mapeo de errores de §6.2.

---

## 2. Qué necesitás antes

- **La key**, solo en el environment de la corrida:
  `ELEVENLABS_API_KEY=... node tasks/cambio-de-voz/_spike-elevenlabs.mjs <video.mp4>`.
  **Nunca** en un archivo del repo: el repo es público. El script **no la imprime nunca**, ni
  enmascarada.
- **Un video unido real con diálogo de Veo, de al menos 60 s.** Lo más simple: en producción,
  Resultado → "Descargar video final". Si dura menos de 270 s, el script arma el audio de 270 s
  repitiendo el del video: sirve para medir límite y latencia, no calidad.
- **Una voz de prueba.** El script toma la primera de `GET /v2/voices?voice_type=default`, o la que
  le pases con `--voz <id>`.

---

## 3. El script (`_spike-elevenlabs.mjs`)

Node 18+, **sin dependencias**: `fetch`, `FormData` y `Blob` nativos, y ffmpeg/ffprobe con
`spawnSync` (es un script, no la app: acá bloquear no importa). Salidas de audio en
`/tmp/spike-voz/` (fuera del repo).

Pasos, en este orden, cada uno con su resultado en consola **y** en `_spike-resultados.md`:

1. `GET /v1/models`: listar los que tienen `can_do_voice_conversion: true`.
2. `GET /v1/user/subscription`: guardar `tier` y `character_count` ("antes").
3. Extraer del video un fragmento de **20 s con habla** (desde el segundo 0 del primer clip con
   diálogo) como WAV mono 44,1 kHz s16. Es el mismo formato que va a mandar la app (diseño §9, paso
   2).
4. **STS de 20 s** con `mp3_44100_128`, `remove_background_noise=true`. Medir:
   - la **Δ duración** de salida contra entrada, en ms (con `ffprobe`);
   - el **corrimiento del primer ataque de voz**: la primera `silence_end` de `silencedetect` con
     `n=-35dB:d=0.15` en la entrada y en la salida (decodificada). Es la resta;
   - la **latencia** del pedido.
5. `GET /v1/user/subscription` otra vez: la diferencia de `character_count` es lo que costó el pedido
   de 20 s (**P-01**).
6. El mismo fragmento con `remove_background_noise=false` → guardarlo aparte para escuchar.
7. El mismo fragmento con `output_format=wav_44100` → ¿200 o error? Anotar status y
   `detail.status` (**P-03**).
8. **STS de 60 s y de 270 s** (mp3): Δ duración, corrimiento y latencia de cada uno.
9. `POST /v1/speech-to-speech/noexiste123` con el fragmento de 20 s: anotar status y cuerpo **sin
   headers**.

El archivo de resultados arranca con la fecha, el `tier` y el modelo usado, y tiene una tabla con
columnas **Δ duración**, **corrimiento**, **latencia** y **créditos** por fila (la verificación B1
busca las palabras `Δ duración` y `créditos`). Al final va una sección **"Decisiones"** que aplica la
tabla de §16 del diseño: qué valor corresponde para `VOICE_OFFSET_MS`, `VOICE_BILLING`,
`ELEVENLABS_OUTPUT_FORMAT` y `ELEVENLABS_TIMEOUT_MS`, y el modelo.

---

## 4. Verificación

```bash
cd /Users/lucho/Desktop/funnel/videogeneradorxd

# 1 — el resultado existe y tiene lo que B1 exige
bash tasks/cambio-de-voz/_verificacion-voz.sh | grep 'B1 '
# esperado:   OK        B1  [T00] resultados del spike anotados

# 2 — la key no quedó en NINGÚN archivo de la carpeta (ni en el script ni en los resultados)
grep -rnE 'sk_[A-Za-z0-9]{20,}|xi-api-key: *[A-Za-z0-9]{20,}' tasks/cambio-de-voz/ || echo "sin keys"
# esperado exactamente: sin keys

# 3 — ningún audio quedó adentro del repo
git status --porcelain tasks/cambio-de-voz/ | grep -vE '_spike-(elevenlabs\.mjs|resultados\.md)$' || echo "solo los 2 archivos"
# esperado exactamente: solo los 2 archivos
```

Y a mano: pasale al usuario las rutas de `/tmp/spike-voz/` con los dos archivos de 20 s (con y sin
ruido de fondo) para que los escuche.

---

## 5. Cuándo parar

**Bloqueante, pará y avisá:**

- **Δ duración > 5 % en cualquier largo.** El enfoque de piezas contiguas (D5) no sirve: §8-§9 se
  rediseñan antes de escribir T03.
- ElevenLabs rechaza un tramo de 270 s en WAV mono de 44,1 kHz (23,8 MB) por tamaño o duración. D4
  asume que entra.
- La key no tiene permiso de Speech to Speech. Sin eso no hay módulo: pedile al usuario una key con
  ese permiso.

**Anotalo en §17 del diseño y seguí:**

- El modelo vigente es otro (P-02), `wav_44100` no está en el plan (P-03), o el costo resultó
  proporcional (P-01). Son variables de entorno: no cambian código.
