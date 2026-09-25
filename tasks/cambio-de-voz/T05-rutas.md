# T05 — Las rutas HTTP

- **Depende de:** T02, T03, T04
- **Bloquea:** T07
- **Se puede correr en paralelo con:** T06 (que se escribe contra el contrato de §11, no contra tu
  código)
- **Archivos que este task puede tocar:** `src/app/api/voces/route.ts`,
  `src/app/api/voces/favoritas/route.ts`, `src/app/api/projects/[id]/voz/route.ts` (los tres nuevos),
  `src/app/api/projects/[id]/route.ts` (solo el `DELETE`),
  `src/app/api/projects/[id]/download/route.ts` (solo agregar las versiones). Nada más.

Leé `02-DISENO.md` completo. Tu contrato es **§11** entero, más D13, D18 y D19 y la tabla de §14.

---

## 1. Objetivo

Las 3 rutas nuevas con exactamente los métodos, cuerpos, respuestas y códigos de §11. Las 2 rutas
existentes con su cambio y nada más. B24-B28 en verde, y A9 y A10 siguen en verde (las rutas nuevas
tienen dueño y tienen quién las llame, esto último cuando T06 esté).

---

## 2. Antes de escribir, leé

| Archivo | Qué mirar |
|---|---|
| `src/app/api/projects/[id]/stitch/route.ts` | el patrón de ruta del repo: `runtime`, `dynamic`, guard, `try/catch` con `serverError` |
| `src/lib/ownership.ts` | `requireProjectOwner(id)` y `sessionUser()`. **El usuario sale de la cookie, nunca del body** (D3 del plan de aislamiento) |
| `src/lib/http.ts` | `ok`, `badRequest`, `notFound`, `serverError`. Para 202/409/502/503: `ok(data, { status })` |
| `src/app/api/projects/[id]/route.ts` | el `DELETE` (108-145): el orden `purgeProject` → `removeProjectDir` → `projectsDb.remove` |
| `src/app/api/projects/[id]/download/route.ts` | `agregar()` (89-95) y el bloque de videos (105-110) |
| `src/lib/voz/index.ts`, `favoritas.ts`, `corrida.ts`, `tramos.ts`, `src/lib/unido.ts` | lo que llamás |

---

## 3. Qué hacer

### `GET/POST/DELETE /api/projects/[id]/voz`

- **Las tres empiezan igual:** `requireProjectOwner(params.id)` → `reconciliarTrasReinicio()` →
  `projectsDb.get`.
- **GET arma `RespuestaEstadoVoz`:**
  - `unido` sale de `estadoDelUnido`;
  - `estimacion` sale de `recetaVigente` + `armarPiezas` + `estimar`, con `config.voz`, en sus tres
    variantes: sin filmados, con filmados (null si `filmadosConDialogo === 0`) y la ventana de
    prueba;
  - `disponible` y `motivoNoDisponible` salen de `vozDisponible(guard.user)`;
  - `activa = corridaVivaDe(project)`.
- **POST:**
  1. Valida el cuerpo a mano, sin zod para esto:
     - `accion` en el enum;
     - `voz.id` con `VOICE_ID_RE`;
     - `voz.nombre` de 1..80 caracteres;
     - cada número de `ajustes` en 0..1.
  2. Para `convertir`/`probar`: `getVozProvider(guard.user)` (su `ErrorDeVoz("no_configurado")`
     → 503) → `iniciarCorrida({ projectId, usuario: guard.user, opciones, proveedor })` → **202**
     `{ version }`.
  3. `ErrorDeCorrida` → 400 o 409 según §11. Siempre `{ error, codigo }`.
- **DELETE `?version=`:**
  - 404 si no existe en **ese** proyecto;
  - 409 si `esCorridaViva(v)`;
  - si no, `removeRel(file)` y saca el registro. Se hace releyendo el proyecto (regla 3 de §10.2).

### `GET /api/voces`

- `sessionUser()` → 401 si es null.
- Valida `lista`; `q` hasta 100 caracteres; `cursor` hasta 500.
- `getVozProvider(usuario)` → según `lista`, lo de §11.
- `creditos()` en un `try` separado: si falla, `null`.
- **Mapeo de errores:**
  - `ErrorDeVoz` `no_configurado` → 503;
  - `key_invalida`, `sin_permiso`, `sin_creditos`, `limite`, `red`, `timeout` → **502**, con el
    mensaje de §14;
  - `validacion` → 400.

### `POST/DELETE /api/voces/favoritas`

`sessionUser()` → 401. Llaman a `guardarFavorita` / `quitarFavorita` con
`config.voz.proveedor`. `ErrorDeVoz("validacion")` → 400.

### `DELETE /api/projects/[id]` — una línea y su comentario

`cancelarCorrida(project.id)` **después** de `purgeProject` y **antes** de `removeProjectDir`, con el
comentario de D18: la corrida recrearía la carpeta con `mkdir recursive`. El chequeo B27 compara las
líneas.

### `GET /api/projects/[id]/download` — el bloque de videos

Después de `agregar(manifest.final_video)`: por cada versión `lista`, `!prueba`, con `file`,
`agregar(v.file)`. Con el comentario de D19.

---

## 4. Verificación

```bash
cd /Users/lucho/Desktop/funnel/videogeneradorxd

# 1 — los chequeos de T05
bash tasks/cambio-de-voz/_verificacion-voz.sh | grep '\[T05\]'
# esperado exactamente: 5 lineas "OK" (B24 a B28)

# 2 — el guard de dueño cubre la ruta nueva, y ninguna ruta lee el usuario del body
bash tasks/cambio-de-voz/_verificacion-voz.sh | grep 'A10 '
# esperado: OK
grep -nE 'body\.(usuario|user|owner)' src/app/api/voces src/app/api/projects/\[id\]/voz -r || echo "usuario solo de la cookie"
# esperado exactamente: usuario solo de la cookie

# 3 — la ruta de voz no usa el proveedor a mano (lo inyecta en la corrida)
grep -n 'crearProveedor' src/app/api -r || echo "solo via getVozProvider"
# esperado exactamente: solo via getVozProvider

# 4 — las rutas contestan de verdad (mock, dev server levantado como en _verificacion-ui-funcional.mjs):
curl -s -b "gen_session=<cookie>" http://127.0.0.1:3100/api/voces?lista=predeterminadas | head -c 300
# esperado: {"proveedor":"mock","voces":[{"id":"mock-grave",...  (4 voces)
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3100/api/voces?lista=predeterminadas
# esperado exactamente: 401   (sin cookie)
curl -s -o /dev/null -w "%{http_code}\n" -b "gen_session=<cookie>" "http://127.0.0.1:3100/api/voces?lista=cualquiera"
# esperado exactamente: 400

# 5 — typecheck
rm -rf .next && npx tsc --noEmit
```

A9 (acciones alcanzables) va a marcar **SIN USO** las 3 rutas nuevas hasta que T06 agregue sus
llamadas. **Es esperado mientras T06 no terminó**; la compuerta de la ola 4 lo exige en verde.

---

## 5. Cuándo parar

**Bloqueante, pará y avisá:**

- Un contrato de T02/T03/T04 no coincide con lo que §11 necesita. **No adaptes la ruta para
  taparlo**: es un desvío del contrato de otra task.
- `cookies()` no funciona en alguna de las rutas nuevas. Todas las de proyecto ya la usan vía
  `ownership.ts`, así que no debería pasar.

**Anotalo en §17 y seguí:** te parece que falta una ruta (por ejemplo, `GET` de una sola versión).
El polling usa el `GET` del estado completo a propósito: un solo lugar de verdad para la pantalla.
