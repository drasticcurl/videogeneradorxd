# T06 — UI: Resultado y el diálogo de cambio de voz

- **Depende de:** T01 (los tipos) y el **contrato** HTTP de §11. No depende de la implementación de
  T05.
- **Bloquea:** T07
- **Se puede correr en paralelo con:** T05
- **Archivos que este task puede tocar:** `src/app/project/[id]/result/page.tsx`,
  `src/components/CambiarVozDialog.tsx` (nuevo), `src/lib/ui-tokens.ts` (solo agregar
  `estadoDeVersionDeVoz`), `tasks/_verificacion-endpoints.sh` (solo agregar **una** línea a la línea
  base, con su motivo). Nada más.

Leé `02-DISENO.md` completo. Tu contrato es **§12** entero, más R2-R9 de `01-REQUISITOS.md` y las
reglas del plan de rediseño: `tasks/00-PLAN-REDISENO-UI.md` §4, §5 y §6.

---

## 1. Objetivo

- **Resultado, solo en `VideoFinal`:**
  - el panel **Voz** (versiones, progreso, Ver/Descargar/Borrar/Reintentar/Rehacer, Cancelar);
  - **"Volver a unir"** con su aviso de desactualizado;
  - el reproductor que sigue a la versión elegida;
  - el polling mientras hay una conversión.
- **`SinVideoFinal`** no cambia, salvo el mensaje de `handleStitch` ante una respuesta no-JSON (§12.1).
- **`CambiarVozDialog`**, con la firma y el comportamiento de §12.2.
- **`estadoDeVersionDeVoz`** en `ui-tokens`, con el mapeo de abajo.
- B29-B32 en verde. A8 (endpoints) y A9 (acciones alcanzables) en verde.

---

## 2. Antes de escribir, leé

| Archivo | Qué mirar | Qué NO hacer |
|---|---|---|
| `src/app/project/[id]/result/page.tsx` | la página entera. Los comentarios largos son decisiones: `preload="none"` sin `poster` (41-49), `IconoCopia` con texto fijo (107-111), el `role="status"` (488-508), el contenedor `cq-size` (580-586) | no "limpiar" comentarios; no tocar la grilla de clips ni el JSON |
| `src/components/ui/Dialog.tsx` | `DialogContent` (ancho 28 rem por defecto, `className` para pisarlo) y `Confirmar` | no modificar la primitiva: está congelada |
| `src/components/ui/index.ts` | las 10 primitivas disponibles: `Segmented`, `ToggleCard`, `Input`, `Badge`, `Progreso`, `Button` (con `loading`), `EmptyState`, `Skeleton` | no escribir botones ni inputs a mano |
| `src/lib/ui-tokens.ts` | `estadoDeJob` (45): la forma de `EstadoVisual` | no cambiar ningún mapeo existente |
| `tasks/_verificacion-endpoints.sh` | `LINEA_BASE` (65-78) y el bloque de "ACTUALIZACION 2026-09-22" (35-64): así se documenta un cambio | **nunca** tocar otra línea "para que pase" |
| `tasks/00-PLAN-REDISENO-UI.md` §4-§6 | tokens, `loading` sin cambio de texto, `label` obligatorio, `Badge` con `tone` | nada de colores literales ni `rounded-full` |

---

## 3. Qué hacer

### `ui-tokens.ts`

```ts
export function estadoDeVersionDeVoz(estado: EstadoVersionDeVoz): EstadoVisual;
// en_cola    -> neutral   "En cola"      animado: no
// procesando -> info      "Convirtiendo" animado: sí
// lista      -> ok        "Lista"        animado: no
// fallida    -> danger    "Falló"        animado: no
// cancelada  -> neutral   "Cancelada"    animado: no
```

### `CambiarVozDialog.tsx`

§12.2 al pie de la letra. Lo que más se olvida:

- **Una sola instancia de `<audio preload="none">`.** Tocar otra voz corta la anterior, y al cerrar
  el diálogo se pausa.
- **Las filas son `<input type="radio">` nativos dentro de `<label>`**: las flechas del teclado
  funcionan sin escribir nada. El botón de favorita lleva `aria-pressed` y un `aria-label` que
  cambia según el estado; el texto visible es un ícono.
- **Debounce de 300 ms en la búsqueda.** Descartá respuestas viejas (si llega la de "nat" después de
  la de "natalia", gana la de "natalia").
- **Los botones "Probar 20 s" y "Cambiar la voz de todo el video" usan `loading`**: el texto no
  cambia (regla 1 de §5 del rediseño).
- **El error del `POST`** se muestra dentro del diálogo, que queda abierto. Un 503 muestra
  `motivoNoDisponible`.
- **Los ajustes** arrancan con los de la favorita elegida, o `null` ("los de la voz").
- **"Incluir clips filmados (N)"** solo si `estado.filmadosConDialogo > 0`. La estimación que se
  muestra cambia con el interruptor (`sinFilmados` / `conFilmados`).

### `result/page.tsx`

§12.1 al pie de la letra. Lo que más se olvida:

- **El polling se limpia al desmontar y se corta cuando `activa` es null.** Un `setInterval` vivo
  después de salir de la pantalla sigue pegándole al server cada 2 s.
- **El reproductor cambia de `src` al elegir otra versión.** `key={src}` para que el navegador no
  muestre el video anterior (mismo criterio que el cache-busting del resto de la app).
- **"Cambiar voz" deshabilitado** con unido desactualizado, sin receta o con `!disponible`. El
  **motivo va visible debajo**, no en un `title`.
- **"Volver a unir"** pasa por `Confirmar` con el detalle de §12.1 y usa el mismo `handleStitch`.
  Deshabilitado mientras hay una conversión activa.
- **El aviso de "lista"** va por el `aria-live` que ya existe (`role="status"`), no por un segundo.
- **`handleStitch`:** si `res.json()` falla (respuesta no-JSON, el 524 de Cloudflare), el mensaje
  pasa a ser el de §12.1. Si el server contesta 409, se muestra el `reason` tal cual.
- **Nada del panel Voz aparece sin unido**: `SinVideoFinal` queda como está.

### `tasks/_verificacion-endpoints.sh`

Una línea nueva en `LINEA_BASE`, ordenada alfabéticamente con las demás:

```
src/components/CambiarVozDialog.tsx|/api/projects/ /api/voces /api/voces/favoritas
```

Y arriba de `LINEA_BASE`, un bloque `ACTUALIZACION <fecha>` que explique por qué: es un archivo
**nuevo** que llama a dos endpoints nuevos, y se lo agrega para que la próxima refactorización no le
pueda sacar un `fetch` sin que salte. La línea de `result/page.tsx` **no cambia**: la llamada a
`/voz` cae en el prefijo `/api/projects/`, que ya estaba.

---

## 4. Verificación

```bash
cd /Users/lucho/Desktop/funnel/videogeneradorxd

# 1 — los chequeos de T06
bash tasks/cambio-de-voz/_verificacion-voz.sh | grep '\[T06\]'
# esperado exactamente: 4 lineas "OK" (B29 a B32)

# 2 — la linea base de endpoints, con la linea nueva
bash tasks/_verificacion-endpoints.sh | tail -1
# esperado exactamente: SIN REGRESIONES

# 3 — con T05 terminado: las 3 rutas nuevas tienen quien las llame
bash tasks/_verificacion-acciones-alcanzables.sh | tail -3
# esperado:   revisados: 28   ...   TODAS LAS ACCIONES SON ALCANZABLES

# 4 — el cliente no importa modulos de server (los tipos van de @/lib/types)
bash tasks/cambio-de-voz/_verificacion-voz.sh | grep 'A7 '
# esperado: OK

# 5 — ningun color literal en lo nuevo
grep -nE '#[0-9a-fA-F]{3,6}\b|(zinc|slate|gray|amber|red|green)-[0-9]{2,3}' src/components/CambiarVozDialog.tsx || echo "solo tokens"
# esperado exactamente: solo tokens

# 6 — ningun switch local de estados de version
grep -nE 'case "(en_cola|procesando|lista|fallida|cancelada)"' src/app/project/\[id\]/result/page.tsx src/components/CambiarVozDialog.tsx || echo "todo via ui-tokens"
# esperado exactamente: todo via ui-tokens

# 7 — typecheck
rm -rf .next && npx tsc --noEmit
```

**A mano, en mock** (dev server como en `_verificacion-ui-funcional.mjs`, más
`VOICE_PROVIDER=mock VOICE_MOCK_DELAY_MS=1500`), en 1440x900 y 1280x720:

1. Unir → aparece el panel Voz con "Original".
2. "Cambiar voz" → 3 pestañas, buscar, elegir, estrella, editar alias.
3. "Probar 20 s" → progreso → queda elegida sola y se ve en el reproductor.
4. "Cambiar la voz de todo el video" → "tramo 1 de 1" → Lista → Descargar (nombre legible) →
   Borrar con confirmación.
5. Solo teclado: Tab hasta "Cambiar voz", flechas en la lista, Espacio en la estrella, Esc cierra.

---

## 5. Cuándo parar

**Bloqueante, pará y avisá:**

- Alguna primitiva de `@/components/ui` no alcanza para §12 (por ejemplo, `Segmented` no acepta
  deshabilitar una opción). **No la modifiques**: está congelada.
- El contrato de §11 no trae un dato que la pantalla necesita. No lo inventes del lado del cliente.

**Anotalo en §17 y seguí:** una mejora visual que §12 no pide (miniaturas por versión, forma de onda).
