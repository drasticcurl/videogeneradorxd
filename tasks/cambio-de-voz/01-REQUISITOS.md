# CAMBIO DE VOZ — Requisitos

**Qué se pide:** que cuando el video final ya está unido, la pantalla de Resultado ofrezca
**"Cambiar voz"**, deje elegir una voz (las de la cuenta de ElevenLabs o las favoritas guardadas en la
app) y genere una versión del video con **todo el diálogo en esa voz**, usando el Voice Changer
(speech-to-speech) de ElevenLabs.

Este archivo dice **qué** tiene que pasar. El **cómo** está en `02-DISENO.md` y el **en qué orden y
quién** en `03-TASKS.md`. Si algo de acá contradice al diseño, gana este archivo y se corrige el
diseño antes de escribir código.

---

## 0. Por qué, y qué hay hoy

Veo genera el audio **clip por clip**, y cada clip es una generación independiente. Consecuencias
concretas en un video unido: la misma persona puede sonar distinta de un clip a otro, y el timbre no
se puede elegir. El Voice Changer de ElevenLabs toma el audio ya grabado y lo re-sintetiza con otra
voz **conservando los tiempos, la emoción y la entonación del original**: el diálogo sigue cayendo en
el mismo lugar, así que el lip-sync de Veo no se rompe.

Lo que ya existe y este módulo usa:

- **El stitch** (`src/lib/ffmpeg.ts:274`, `POST /api/projects/:id/stitch`) une los clips en
  `<nombre-del-proyecto>.mp4`, en la raíz de la carpeta del proyecto.
- **La pantalla Resultado** (`src/app/project/[id]/result/page.tsx`) muestra ese video en
  `VideoFinal` (línea 561) o, si todavía no hay unido, el botón "Unir en un video" en
  `SinVideoFinal` (línea 647).
- **Un hueco que este módulo cierra:** una vez que el video está unido, `VideoFinal` **no ofrece
  volver a unir**. Si después se regenera un clip, el unido queda viejo y no hay forma de rehacerlo
  desde la interfaz.

---

## 1. Decisiones del usuario (2026-09-25) — cerradas

| # | Pregunta | Respuesta |
|---|---|---|
| U1 | ¿De dónde salen las voces? | Las de la cuenta de ElevenLabs (clonadas, guardadas y predeterminadas) **+ favoritas guardadas en la app**, con alias y ajustes propios |
| U2 | ¿Una voz o una por persona? | **Una sola voz para todo el video**, aunque hablen dos personas distintas |
| U3 | ¿Qué entra en la v1? | El botón en Resultado **+ "Volver a unir"** |
| U4 | ¿Dónde van los documentos? | `tasks/cambio-de-voz/`, con la convención del repo |

Supuestos que se le plantearon al usuario antes de preguntar y **no se objetaron**. Son requisitos:

- El original **se conserva**: cada voz genera un archivo aparte.
- Hay una **prueba corta** (~20 s) antes de convertir todo el video.
- Los clips **sin diálogo** conservan su audio. Los **`FILMAR_REAL`** también, salvo que se pida
  incluirlos.
- **"Quitar ruido de fondo"** prendido por defecto.
- La API key vive **solo en el server**: una compartida y, opcional, una por usuario.
- Existe un **modo mock** que no gasta, igual que `PROVIDER_MODE=mock`.

---

## 2. Glosario

| Término | Qué es |
|---|---|
| **Unido** | El `.mp4` que produce el stitch. Hoy se llama `<slug-del-proyecto>.mp4` (los viejos, `final.mp4`) |
| **Receta del unido** | Lo que el stitch deja anotado al unir: qué clips entraron, en qué orden, dónde empieza y termina cada uno dentro del unido, y la huella (fecha de modificación + tamaño) de cada archivo |
| **Unido desactualizado** | Un unido cuyos clips cambiaron después de unir (se regeneró uno, se subió un `FILMAR_REAL`, se agregó o sacó un clip) |
| **Versión de voz** | Un `.mp4` nuevo: el mismo video que el unido, con el audio convertido a otra voz |
| **Prueba** | Una versión de voz de ~20 s, para escuchar antes de gastar en el video entero |
| **Tramo** | Un pedazo de audio que se manda en **un** pedido a ElevenLabs (máximo 5 min por pedido) |
| **Favorita** | Una voz marcada por el usuario **en la app**, con alias y ajustes opcionales |
| **Corrida** | La conversión en curso de una versión de voz |

---

## 3. Historias de usuario y criterios de aceptación

Formato EARS: *CUANDO / SI / MIENTRAS … el sistema DEBE …*. Cada criterio es verificable y tiene su
chequeo en `03-TASKS.md` §6.

### R1 — Cambiar la voz de todo el video

> Como quien produce el video, quiero que todo el diálogo del video unido pase a una voz que elijo,
> para que suene como una sola persona de principio a fin.

1. **CUANDO** el proyecto tiene video unido, la pantalla Resultado **DEBE** mostrar el botón
   **"Cambiar voz"**.
2. **CUANDO** confirmo una voz, el sistema **DEBE** generar un `.mp4` nuevo con el audio de **todos**
   los clips con diálogo convertido a esa voz (una sola voz, U2), incluido el b-roll con voz en off.
3. El video de la versión **DEBE** ser idéntico al del unido: el video no se re-encodea, se copia.
4. La versión **DEBE** durar lo mismo que el unido (±50 ms) y cada clip **DEBE** seguir empezando en el
   mismo instante: el diálogo convertido no puede correrse respecto de la boca.
5. **SI** el video dura más de 5 minutos, el sistema **DEBE** partirlo en tramos que cortan **en el
   borde entre dos clips**, nunca a mitad de un clip. La única excepción es un clip que dure más de
   5 min por sí solo, que no existe en esta app (máximo 8 s, o 15 s extendido).

### R2 — Elegir la voz

1. El selector **DEBE** tener tres listas: **Favoritas**, **Mis voces** (todo lo de la cuenta que no
   es predeterminado: clonadas, diseñadas, profesionales y las agregadas desde la Voice Library) y
   **Predeterminadas**.
2. **DEBE** poder buscarse por texto (nombre, acento, descripción).
3. Cada voz **DEBE** mostrar nombre y etiquetas (acento, género, edad), y **DEBE** poder escucharse su
   muestra **sin gastar créditos**, si ElevenLabs la ofrece.
4. **CUANDO** la cuenta tiene más voces que las que entran en una página, **DEBE** haber "Cargar más".

### R3 — Favoritas en la app

1. **DEBE** poder marcarse cualquier voz como favorita con un clic, y desmarcarla igual.
2. Una favorita **DEBE** poder tener un **alias** (ej. "Natalia VSL", máx. 60 caracteres) y
   **ajustes propios** (estabilidad, similitud, estilo, realce del hablante).
3. **CUANDO** elijo una favorita con ajustes, el diálogo **DEBE** arrancar con esos ajustes.
4. Las favoritas **DEBEN** ser **por usuario**: las de Lucho no las ve Ivan.
5. **SI** una favorita ya no existe en la cuenta de ElevenLabs, la lista **DEBE** mostrarla como "ya
   no está en tu cuenta" y dejarla borrar, sin romper el resto de la lista.
6. **DEBE** haber un tope de 50 favoritas por usuario.

### R4 — Probar antes de gastar

1. **DEBE** haber **"Probar 20 s"**: convierte una ventana de ~20 s que arranca en el primer clip con
   diálogo, y genera un `.mp4` corto que se ve en el mismo reproductor.
2. La prueba **DEBE** procesarse exactamente igual que la conversión completa (mismos ajustes, mismas
   reglas de qué se conserva): es una muestra fiel del resultado.
3. Las pruebas **NO DEBEN** entrar en el `.zip` de descarga.

### R5 — El original se conserva, y las versiones se administran

1. Convertir **NUNCA DEBE** pisar el unido: cada conversión es un archivo nuevo.
2. Resultado **DEBE** listar el original y cada versión (voz, fecha, estado, duración, peso), y
   **DEBE** dejar verla en el reproductor, descargarla con un nombre legible
   (`<proyecto>__voz-<voz>.mp4`) y borrarla, con confirmación.
3. **"Todo (zip)"** **DEBE** incluir las versiones de voz terminadas (no las pruebas).

### R6 — Qué clips se convierten

1. Los clips **sin diálogo** **DEBEN** conservar su audio original **siempre**.
2. Los clips **`FILMAR_REAL`** **DEBEN** conservar su audio por defecto. **SI** el proyecto tiene clips
   `FILMAR_REAL` con diálogo, el diálogo **DEBE** ofrecer **"Incluir clips filmados (N)"**.
3. **SI** no queda ningún clip para convertir, el sistema **DEBE** decirlo y no iniciar nada.

### R7 — Trabajo en segundo plano

1. Iniciar una conversión **DEBE** devolver la respuesta al instante. La conversión sigue en el server
   aunque se cierre la pestaña.
2. **MIENTRAS** convierte, Resultado **DEBE** mostrar el estado y el progreso por tramo ("tramo 2 de
   3"), y **DEBE** ofrecer **"Cancelar"**.
3. **DEBE** haber **una sola conversión a la vez por proyecto**. En toda la app corre una sola por
   vez; las demás esperan "en cola".
4. **SI** el server se reinicia a mitad, la conversión **DEBE** quedar marcada como fallida, con el
   motivo, y **NO DEBE** retomarse sola, porque retomarla gasta créditos.
5. La app **NO DEBE** congelarse mientras convierte: nada de procesos síncronos largos.

### R8 — Volver a unir, y saber cuándo hace falta

1. **CUANDO** hay video unido, Resultado **DEBE** ofrecer **"Volver a unir"**, con confirmación que
   diga cuánto tarda aproximadamente.
2. **SI** los clips cambiaron después de unir, Resultado **DEBE** avisarlo ("Los clips cambiaron desde
   que se unió") con el motivo concreto (qué clip).
3. **MIENTRAS** el unido esté desactualizado, "Cambiar voz" **DEBE** quedar bloqueado, explicando que
   primero hay que volver a unir.
4. **SI** el video se unió antes de que existiera este módulo (sin receta), Resultado **DEBE** decir
   que hay que volver a unir **una vez** para habilitar el cambio de voz.
5. **MIENTRAS** hay una conversión en curso, volver a unir **DEBE** rechazarse con un mensaje claro.
6. Las versiones hechas sobre un unido anterior **DEBEN** marcarse ("hecha sobre un unido anterior") y
   ofrecer **"Rehacer con esta voz"**.

### R9 — Costo a la vista

1. Antes de confirmar, el diálogo **DEBE** mostrar cuántos segundos se van a convertir, en cuántos
   tramos, y una estimación de créditos y de USD.
2. **SI** la cuenta lo permite, **DEBE** mostrar los créditos que quedan.
3. En modo mock **DEBE** decir que no gasta.

### R10 — Errores que se entienden

**CUANDO** algo falla, la versión **DEBE** quedar "Falló" con un mensaje en castellano que diga qué
hacer. Como mínimo estos casos, cada uno con su mensaje propio (tabla completa en `02-DISENO.md` §14):

- sin créditos
- API key inválida
- API key sin permisos
- la voz ya no existe
- ElevenLabs saturado después de reintentar
- red o timeout
- falla de ffmpeg
- el unido cambió a mitad de la conversión

### R11 — Seguridad y aislamiento

1. La API key **NUNCA DEBE** llegar al navegador ni a un log.
2. **DEBE** poder configurarse una key por usuario (`ELEVENLABS_API_KEY_<NOMBRE>`) que pisa a la
   compartida (`ELEVENLABS_API_KEY`).
3. Todas las rutas nuevas de proyecto **DEBEN** chequear el dueño (`requireProjectOwner`), y las de
   voces **DEBEN** exigir sesión.
4. El id de voz que manda el cliente **DEBE** validarse antes de usarse en una URL de ElevenLabs.
5. Borrar el proyecto **DEBE** cancelar su conversión antes de borrar la carpeta.

### R12 — Modo mock

**CON** `VOICE_PROVIDER=mock` (el default), todo el circuito **DEBE** funcionar sin credenciales y sin
gastar:

- lista de voces
- favoritas
- prueba
- conversión
- cancelación
- versiones
- volver a unir

La "conversión" mock **DEBE** cambiar el audio de forma audible y verificable (sube el tono) sin
cambiar la duración.

---

## 4. Requisitos no funcionales

| Tema | Requisito |
|---|---|
| **Rendimiento** | El paso de video es copia de stream (segundos, no minutos). Todo ffmpeg del módulo es asíncrono (`spawn`, no `spawnSync`) y respeta el límite de cores de `runFfmpeg` |
| **Costo** | Pocos pedidos por video: tramos de hasta 270 s. Si ElevenLabs cobra por minuto redondeado, convertir clip por clip costaría hasta 7,5 veces más |
| **Límites externos** | ≤ 300 s y ≤ 50 MB por pedido. Un tramo de 270 s en WAV mono 44,1 kHz pesa 23,8 MB |
| **Operación** | Sigue siendo **una sola instancia de PM2**: la cola de voz vive en memoria, como la de jobs |
| **Idioma** | UI y mensajes en castellano rioplatense. Los diálogos no se tocan: se convierte el audio, no el texto |
| **Diseño** | Solo tokens y primitivas de `@/components/ui` (reglas del plan de rediseño, §4-§6) |
| **Accesibilidad** | Foco visible, `label` en todo campo, el progreso anunciado con `aria-live`, lista de voces navegable con teclado |
| **Observabilidad** | Inicio, fin, fallo y cancelación van al log del proyecto (`logEvent` → `pipeline.log`) |
| **Privacidad** | El audio del video sale de la VPS hacia ElevenLabs. Se documenta en el README |

---

## 5. Fuera de alcance (v1)

Ningún agente lo agrega por su cuenta:

- **Una voz distinta por persona o avatar.** El usuario eligió una sola voz (U2). La receta guarda el
  `asset_id` de cada clip para que agregarlo después no obligue a volver a unir todo.
- **Clonar voces desde la app** y **explorar la Voice Library pública.** Se hacen en elevenlabs.io.
  Lo que se guarda allá aparece en "Mis voces".
- **Cambiar la voz en lote desde `/batch`** o de un clip suelto desde el pipeline.
- **Doblaje o traducción** (otro idioma). El Voice Changer conserva el idioma y el acento del
  original.
- **Arreglar el acento o la pronunciación.** El Voice Changer cambia el timbre, no lo que Veo dijo.
- **Stitch asíncrono.** El stitch sigue siendo síncrono (ver P-04 en el diseño): "Volver a unir" usa
  el mismo endpoint de siempre.
- **Normalizar el volumen** entre tramos convertidos y conservados (P-05).
- **Meter las versiones de voz en `manifest.json`.**
- **Tests con framework.** El repo no tiene uno. La verificación son los scripts de esta carpeta.

---

## 6. Supuestos y dependencias externas

- **Cuenta de ElevenLabs** con créditos, y una API key **restringida**:
  - "Speech to Speech", obligatorio.
  - "Voices" en lectura, obligatorio.
  - "User" en lectura, opcional: solo sirve para mostrar los créditos.

  Hoy `.env.local` no tiene ninguna variable `ELEVENLABS_*`.
- **Precio de referencia, 2026-09-25:** US$0,12 por minuto por API, y 1.000 créditos por minuto de
  audio. Si ElevenLabs **redondea al minuto por pedido** no está confirmado: lo mide el spike (T00,
  P-01).
- **Modelo:** `eleven_multilingual_sts_v2` (29 idiomas, incluye español). El spike confirma que sigue
  siendo el vigente.
- **ffmpeg y ffprobe** en el server. Ya los exige `deploy.sh` (guard 3e).

---

## 7. Trazabilidad

| Requisito | Diseño | Task |
|---|---|---|
| R1 | D1, D2, D4, D5, §9 | T03, T01 |
| R2 | §6, §11 (`GET /api/voces`), §12 | T02, T05, T06 |
| R3 | D14, §6, §11 (favoritas) | T02, T05, T06 |
| R4 | §8 (ventana), §9 (prueba) | T03, T06 |
| R5 | D8, D19, §11 (DELETE versión, zip) | T03, T05, T06 |
| R6 | D9, §8 | T03, T06 |
| R7 | D10, D11, D12, §10 | T03, T05, T06 |
| R8 | D6, D7, D17, §7 | T01, T04, T06 |
| R9 | §8 (`estimar`), §11 | T03, T05, T06 |
| R10 | §14 | T02, T03, T06 |
| R11 | D13, D18, §13 | T01, T02, T05 |
| R12 | D16, §6 (mock) | T02, T07 |
