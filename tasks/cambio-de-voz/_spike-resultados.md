# T00 — Resultados del spike de ElevenLabs

- **Fecha:** 2026-09-25T20:35:25.944Z
- **Plan (tier):** sin permiso de user_read
- **Modelo usado:** eleven_multilingual_sts_v2
- **Video:** `01_pregunta-2.mp4` (45.2 s, Veo). Los tramos de 60 y 270 s repiten su audio
  (`-stream_loop`): sirven para límite, deriva y latencia, no para calidad.
- **Voz:** `pNInz6obpgDQGcFmaJgB`

## Mediciones

| Pedido | Entrada | Salida | Δ duración | Corrimiento | Latencia | Créditos |
|---|---|---|---|---|---|---|
| salida_20s_con-quitar-ruido | 20.000 s | 20.016 s | 16 ms (0.08 %) | -28 ms (silence_start) | 5.4 s | — |
| salida_20s_sin-quitar-ruido | 20.000 s | 20.016 s | 16 ms (0.08 %) | -42 ms (silence_start) | 4.3 s | — |
| salida_60s | 59.979 s | 60.000 s | 22 ms (0.04 %) | -17 ms (silence_start) | 14.3 s | — |
| salida_270s | 269.893 s | 269.909 s | 15 ms (0.01 %) | -15 ms (silence_start) | 56.4 s | — |

- Créditos de 60 s + 270 s juntos: sin medir
- Modelos con `can_do_voice_conversion`: sin medir
- `output_format=wav_44100`: 403: {"detail":{"type":"authorization_error","code":"subscription_required","message":"Output format 'wav_44100' is only available on the Pro tier and above.","status":"output_format_not_allowed","request_id":"f82f47e1040216c71d2f1f3bbe89d57d"}}
- `voice_id` inexistente: 404 {"detail":{"type":"not_found","code":"voice_not_found","message":"A voice with voice_id 'noexiste123' was not found.","status":"voice_not_found","request_id":"5be8b33173ae6e83d5ac71020312b715"}}

## Log

```
1. GET /v1/models -> 401: {"detail":{"type":"authentication_error","code":"unauthorized","message":"The API key you used is missing the permission models_read to execute this operation.","status":"missing_permissions","request_id":"6ec76daf91598894c53d8202d5fd459c"}}
2. /v1/user/subscription -> 401 (la key no tiene user_read)
   Voz de prueba: Adam - Dominant, Firm (pNInz6obpgDQGcFmaJgB)
3. Fragmento de 20 s extraído de 01_pregunta-2.mp4 (45.2 s)
4. STS 20 s, mp3_44100_128, remove_background_noise=true
   salida_20s_con-quitar-ruido: entrada 20.000 s · salida 20.016 s · Δ 16 ms (0.08 %) · corrimiento -28 ms (silence_start) · latencia 5.4 s
5. No se pudo leer la suscripción: créditos sin medir
6. STS 20 s, remove_background_noise=false
   salida_20s_sin-quitar-ruido: entrada 20.000 s · salida 20.016 s · Δ 16 ms (0.08 %) · corrimiento -42 ms (silence_start) · latencia 4.3 s
7. STS 20 s, output_format=wav_44100
   403: {"detail":{"type":"authorization_error","code":"subscription_required","message":"Output format 'wav_44100' is only available on the Pro tier and above.","status":"output_format_not_allowed","request_id":"f82f47e1040216c71d2f1f3bbe89d57d"}}
8. STS 60 s y 270 s (mp3)
   salida_60s: entrada 59.979 s · salida 60.000 s · Δ 22 ms (0.04 %) · corrimiento -17 ms (silence_start) · latencia 14.3 s
   entrada de 270 s: 23.8 MB
   salida_270s: entrada 269.893 s · salida 269.909 s · Δ 15 ms (0.01 %) · corrimiento -15 ms (silence_start) · latencia 56.4 s
9. STS con voice_id inexistente
   404 {"detail":{"type":"not_found","code":"voice_not_found","message":"A voice with voice_id 'noexiste123' was not found.","status":"voice_not_found","request_id":"5be8b33173ae6e83d5ac71020312b715"}}
```

## Decisiones (tabla de §16 del diseño)

- **Hallazgo para §6.2:** un formato no permitido por el plan vuelve **403** con
  `detail.status = output_format_not_allowed`. La tabla de errores de §6.2 no tiene 403 (anotado en P-07)

- **Δ duración máxima:** 22 ms (0.08 %). ≤ 50 ms: D5 tal cual.
- **VOICE_OFFSET_MS:** 0. El corrimiento medido es negativo y chico (-15 a -42 ms: la salida arranca apenas
  antes, no después) y no es fijo; `VOICE_OFFSET_MS` solo recorta al inicio, así que no aplica
- **VOICE_BILLING:** sin medir: la key no tiene `user_read`, así que tampoco se van a poder mostrar los créditos
  que quedan (R9.2 es opcional). Queda `por_minuto`; P-01 se mide en T08 mirando el panel de ElevenLabs
- **ELEVENLABS_OUTPUT_FORMAT:** `mp3_44100_128` (wav no disponible en el plan)
- **ELEVENLABS_TIMEOUT_MS:** 180000 alcanza
- **Modelo:** `eleven_multilingual_sts_v2`. Las 4 conversiones corrieron con él, así que sigue vigente. La lista de
  modelos no se pudo leer: la key no tiene `models_read` (P-02 queda abierta, no bloquea)

Audios para escuchar (fuera del repo): `/tmp/spike-voz/salida_20s_con-quitar-ruido.mp3` y `/tmp/spike-voz/salida_20s_sin-quitar-ruido.mp3`.
