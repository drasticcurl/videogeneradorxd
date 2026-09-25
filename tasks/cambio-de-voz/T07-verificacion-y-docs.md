# T07 — Verificación de punta a punta (mock), deploy y documentación

- **Depende de:** T05 y T06
- **Bloquea:** T08
- **Se puede correr en paralelo con:** nada
- **Archivos que este task puede tocar:** `tasks/cambio-de-voz/_verificacion-voz-mock.mjs` (nuevo),
  `tasks/_verificacion-ui-funcional.mjs`, `deploy/deploy.sh`, `README.md`, `CHANGELOG.md`,
  `docs/BITACORA-IMPLEMENTACION.md`, `.kiro/steering/project-context.md`. **Nada de `src/`.**

Leé `03-TASKS.md` §4 (criterios globales) y `02-DISENO.md` completo.

---

## 1. Objetivo

- Un script E2E que prueba el módulo **dentro de la app**, en mock, con los 14 casos de §3. Termina
  en `VOZ OK (mock)`.
- `_verificacion-ui-funcional.mjs` mira también Resultado:
  - los botones "Cambiar voz" y "Volver a unir";
  - que no haya desborde en los 3 tamaños de laptop.
- `deploy.sh` aborta si `VOICE_PROVIDER=elevenlabs` y no hay ninguna key.
- README, CHANGELOG, bitácora y steering al día.
- `_verificacion-voz.sh` da **B33-B39 en verde**. Todo menos B1 y B40, que son de T00 y T08.

**Si el E2E encuentra un bug, este task NO lo arregla en `src/`**: lo reporta con el caso que falla y
vuelve a la task dueña del archivo. Es la regla de ownership de `03-TASKS.md` §3.

---

## 2. Antes de escribir, leé

- `tasks/_verificacion-ui-funcional.mjs` entero. El E2E nuevo copia **su patrón**:
  - login por fetch;
  - sembrar por API;
  - sin dependencias;
  - app levantada en `:3100` en mock;
  - "NUNCA apuntarlo a producción".
- `deploy/deploy.sh` §3 (guards 3a-3e): el estilo de `fail` y `log`, y **por qué** cada guard aborta
  antes del build.
- `CHANGELOG.md` y `docs/BITACORA-IMPLEMENTACION.md`: el formato (fecha, qué, **por qué**, el bug
  que evita).

---

## 3. `_verificacion-voz-mock.mjs` — los 14 casos

**Requisitos de arranque**, en la cabecera del script: el mismo comando que
`_verificacion-ui-funcional.mjs`, más:

```
VOICE_PROVIDER=mock VOICE_MOCK_DELAY_MS=1500 PIPELINE_AUTO_APPROVE=true \
PASSWORD_OTRO=otrootrootrootrootrootrootrootrootrootro
```

El segundo usuario es para el caso 11. `ffmpeg` y `ffprobe` tienen que estar en el `PATH` de la
máquina que corre el script: se usan para comparar archivos.

**Siembra:** un proyecto de 4 clips con los mismos cuatro casos del ejemplo de §8 del diseño:

- c1 y c2 IA con diálogo;
- c3 `FILMAR_REAL` con diálogo, subido por `POST /upload` con un mp4 que el script genera con
  ffmpeg, **con un tono distinto** (660 Hz), para poder reconocerlo;
- c4 IA sin diálogo.

`generate` y esperar a que los clips IA estén `done`.

| # | Caso | Qué se afirma |
|---|---|---|
| 1 | Unir | `POST /stitch` → `ok: true` y `recetaUnido` con 4 clips contiguos (`fin(i) == inicio(i+1)`); `duracionSeg` a ±0,1 s de `ffprobe` del unido |
| 2 | Estado | `GET /voz` → `unido.conReceta: true`, `desactualizado: false`, `filmadosConDialogo: 1`, `activa: null`, `proveedor: "mock"` |
| 3 | Estimación | `estimacion.sinFilmados.segundos` ≈ duración de c1+c2 (±0,1); `conFilmados.segundos` ≈ c1+c2+c3; `tramos: 1` |
| 4 | Prueba | `POST {accion:"probar", voz:{id:"mock-aguda"...}}` → **202**; polling hasta `lista`; el archivo existe; su duración es `min(20, …)` ±0,1 |
| 5 | Conversión + 409 | `POST {accion:"convertir"...}` → 202; **mientras** está `procesando` (la demora del mock lo garantiza), `POST /stitch` → **409** con `reason`. Después, `lista` |
| 6 | El resultado | Bajar la versión por `/api/files`. Duración == unido (±0,05); **md5 del stream de video idéntico**; `duration_ts` del audio decodificado igual (±1 frame AAC = 1024). **Qué se convirtió y qué no, por tono**, con el método de §1 del diseño (`bandpass` + `silencedetect`): los clips IA del mock suenan a 220 Hz y el mock sube un 25 %, así que en la versión la banda de **275 Hz** suena en c1+c2 y está en silencio en c3 y c4; la de **220 Hz** suena **solo** en c4 (sin diálogo, conservado); y la de **660 Hz** suena en c3 (el filmado, conservado). **No se compara el md5 del PCM**: el audio conservado vuelve a pasar por AAC, que tiene pérdida, así que las muestras cambian aunque el sonido sea el mismo |
| 7 | Cancelar | `POST convertir` y enseguida `POST {accion:"cancelar"}` → `cancelada: true`; la versión queda `cancelada`, sin `file`, y `voz/_trabajo/` no existe en el disco del proyecto |
| 8 | Desactualizado | Regenerar c2 (`POST /api/jobs/<id>/retry`, esperar `done`) → `GET /voz` da `desactualizado: true` con un motivo que menciona el clip 02; `POST convertir` → **400** `codigo: "desactualizado"`; `POST /stitch` → OK → `desactualizado: false`; las versiones anteriores tienen `recetaCreadaEn` distinto de la receta nueva |
| 9 | Zip | `GET /download` → la lista del zip (`unzip -l`) contiene la versión completa y **no** la prueba |
| 10 | Borrar versión | `DELETE /voz?version=<id>` → 200; el archivo ya no está y el registro tampoco; borrar una viva → **409** |
| 11 | Aislamiento | Con el usuario `otro`: `GET /api/projects/<pid>/voz` → **404**; `GET /api/voces?lista=favoritas` → sus favoritas (vacías), no las del primero |
| 12 | Voces y favoritas | `GET /api/voces?lista=predeterminadas` → 4 voces mock; `POST /favoritas {voiceId:"mock-grave", alias:"Grave test"}` → aparece en `lista=favoritas` con ese alias; `voiceId:"../x"` → **400**; `DELETE` → desaparece |
| 13 | Borrar el proyecto a mitad | `POST convertir` y, mientras está `procesando`, `DELETE /api/projects/<pid>` → 200; **3 s después la carpeta del proyecto NO existe** (D18) |
| 14 | Sin sesión | `GET /api/voces` y `GET /api/projects/<pid>/voz` sin cookie → 401 |

Cada caso imprime `OK` o `MAL` con lo esperado y lo real. Termina en `VOZ OK (mock)` y exit 0, o en
`FALLOS: N` y exit 1.

---

## 4. Lo demás

- **`_verificacion-ui-funcional.mjs`:**
  - la siembra además une el proyecto (`POST /stitch`) y agrega a `ESPERADOS` la pantalla
    `"resultado"`, con `presentes: ["Cambiar voz", "Volver a unir"]`;
  - "result" ya está en la vuelta de layout: ahora se mide **con** video unido y panel Voz, que es el
    caso con más contenido.
- **`deploy.sh`**, un guard **3f**, en el estilo de 3d:

  ```bash
  # 3f. Cambio de voz. VOICE_PROVIDER=elevenlabs sin key compila y arranca, pero cada conversion
  # falla en runtime con "no esta configurado". Mejor que el deploy se detenga y se vea.
  if [[ "${VOICE_PROVIDER:-mock}" == "elevenlabs" ]]; then
    grep -qE '^ELEVENLABS_API_KEY(_[A-Z0-9_]+)?=.+' "$RELEASE/.env.production" \
      || fail "VOICE_PROVIDER=elevenlabs pero no hay ninguna ELEVENLABS_API_KEY en .env.production"
    log "voz: elevenlabs"
  fi
  ```

  **Nunca imprimir la key**: ni en el `log`, ni en el `fail`.
- **README:**
  - sección **`## Cambio de voz`**: qué hace, cómo se configura (key restringida y sus permisos),
    el mock, costos, la privacidad (el audio sale hacia ElevenLabs), y qué NO hace (acento, una voz
    por persona);
  - filas en la tabla de API: las 3 rutas nuevas con sus métodos;
  - filas en la tabla de variables de entorno;
  - `voz/` en "Dónde quedan los archivos";
  - filas en "Solución de problemas": sin créditos, key sin permisos, 409 al unir, "volvé a unir una
    vez".
- **De paso, en el README y en el steering: la sección "Limitación conocida: los proyectos no están
  aislados por usuario" quedó vieja.** El aislamiento está implementado desde `e66bd83`. El propio
  steering dice *"Si algo de acá contradice al código, gana el código — y actualizá este archivo en
  el mismo commit"*. Corregila en los dos archivos, en una línea que diga que está hecho y dónde.
- **CHANGELOG:** la entrada de la tanda, con qué y por qué, en el formato de siempre.
- **Bitácora:** la entrada del módulo:
  - qué se decidió sin especificación;
  - qué falta verificar: P-01 a P-06;
  - los números del E2E.
- **Steering:** el módulo `src/lib/voz/` en "Archivos importantes", las dos variables clave y la
  regla de "una sola instancia" (la cola de voz también vive en memoria).

---

## 5. Verificación

```bash
cd /Users/lucho/Desktop/funnel/videogeneradorxd

# 1 — E2E (dev server en mock levantado como dice la cabecera del script)
node tasks/cambio-de-voz/_verificacion-voz-mock.mjs | tail -1
# esperado exactamente: VOZ OK (mock)

# 2 — UI funcional, con Resultado incluido
node tasks/_verificacion-ui-funcional.mjs | tail -1
# esperado exactamente: UI OK

# 3 — el modulo completo salvo T00/T08
bash tasks/cambio-de-voz/_verificacion-voz.sh | tail -3
# esperado:  verde: 48   pendiente: 2   FALLO: 0   (B1 y B40; 49/1 si T00 ya corrio)

# 4 — el guard de deploy, en seco: con VOICE_PROVIDER=elevenlabs y sin key tiene que fallar
bash -n deploy/deploy.sh && echo "sintaxis ok"
grep -n 'ELEVENLABS_API_KEY' deploy/deploy.sh | grep -viE 'grep|fail|#' || echo "no imprime la key"
# esperado: sintaxis ok / no imprime la key

# 5 — build completo (pedido explicito del plan; NO con el dev server levantado: los dos escriben .next/)
npm run build
```

---

## 6. Cuándo parar

**Bloqueante, pará y avisá:** un caso del E2E falla. No lo arregles acá: decí qué caso, qué esperaba,
qué dio, y cuál es la task dueña del archivo.

**Anotalo en §17 y seguí:** el E2E revela algo que el contrato no cubre (por ejemplo, un orden de
estados que la UI no espera).
