# Plantilla del prompt de video (Veo)

Este archivo es la **fuente de verdad** del prompt que la app le manda a Veo.
La aplicación lo lee en runtime (`src/lib/promptTemplate.server.ts`): si lo editás,
los prompts que se generan cambian, **sin recompilar**. Podés descargarlo desde la
app (botón "Descargar plantilla (MD)" en el editor de cada clip) o desde
`GET /api/prompt-template?download=1`.

## Cómo se arma el prompt final

El prompt se ensambla con estos bloques, en este orden:

1. `intro` — siempre.
2. El `video_prompt` del clip (la descripción visual que escribiste) — siempre que exista.
3. Según el tipo de clip:
   - **avatar + diálogo** → `talking_head` + `voice_accent` + `dialogue_line`
   - **b-roll + diálogo** → `broll_voiceover` + `voice_accent` + `voiceover_line`
   - **sin diálogo** → `silent`

Si un clip tiene un *override* manual del prompt final, esta plantilla se ignora
y se manda exactamente lo que escribiste.

## Placeholders disponibles

- `{{duration}}` — duración del clip en segundos (4, 6 u 8).
- `{{aspect}}` — relación de aspecto (ej. `9:16`).
- `{{dialogue}}` — la línea hablada (es-AR). Solo en `dialogue_line` / `voiceover_line`.

> Importante: NO cambies los nombres de los bloques (`<!-- block:xxx -->`). El texto
> de adentro sí podés editarlo libremente. Si borrás un bloque, la app usa el default.

---

## Bloques

### Intro (siempre)

<!-- block:intro -->
Animate the attached image into a realistic {{duration}}-second vertical {{aspect}} video.
<!-- /block -->

### Talking-head / avatar (persona hablando a cámara, con diálogo)

> El encuadre NO está fijo a "teléfono en la mano". Puede ser un selfie a distancia
> de brazo o la persona grabándose con el teléfono/cámara apoyado en un trípode.
> Editá esta parte para fijar un estilo concreto si lo necesitás.

<!-- block:talking_head -->
Self-recorded UGC style: the person records themselves talking directly to camera. The recording setup can be either a phone held at arm's length OR a phone/camera mounted on a tripod (or a steady surface) with the person speaking hands-free — choose whatever looks most natural for this shot, do NOT force a phone visibly held in hand. Natural casual head and hand movement, warm hopeful conversational tone, relaxed natural framing, accurate lip-sync to the spoken line. No on-screen text. {{aspect}}.
<!-- /block -->

### B-roll con voz en off (inserto sin cara hablando, el diálogo es narración)

<!-- block:broll_voiceover -->
B-roll insert: NO person talking to camera and NO visible talking face or lip-sync. Show only the scene and action described above, with smooth natural camera movement and realistic lighting. The line below plays as OFF-SCREEN VOICEOVER narration over the footage (nobody mouths it on screen). No on-screen text. {{aspect}}.
<!-- /block -->

### Silencioso (sin diálogo)

<!-- block:silent -->
Smooth natural motion with subtle camera movement and realistic lighting. No spoken dialogue. No on-screen text. {{aspect}}.
<!-- /block -->

### Voz y acento (se agrega siempre que haya diálogo, sea a cámara o en off)

<!-- block:voice_accent -->
VOICE & ACCENT (very important): the person speaks in RIOPLATENSE ARGENTINE SPANISH (Buenos Aires / porteno accent), NOT Mexican, NOT Castilian, NOT neutral Latin American Spanish. Use the characteristic Argentine intonation, "voseo" (vos / tenes / mande / mira), the typical "sh" sound for "ll" and "y" (yo = "sho", ya = "sha", llave = "shave"), and a relaxed, melodic portena cadence. Natural adult voice, warm and conversational, casual everyday delivery.
<!-- /block -->

### Línea de diálogo a cámara (talking-head)

<!-- block:dialogue_line -->
[DIALOGO] (speak exactly this, in Rioplatense Argentine Spanish): "{{dialogue}}"
<!-- /block -->

### Línea de voz en off (b-roll)

<!-- block:voiceover_line -->
[VOZ EN OFF / VOICEOVER] (off-screen narration, speak exactly this in Rioplatense Argentine Spanish): "{{dialogue}}"
<!-- /block -->
