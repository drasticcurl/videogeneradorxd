# T03 — JobCard: la tarjeta de job, el componente más reusado

- **Depende de:** T01 (primitivas y `ui-tokens`)
- **Bloquea:** T07, T09, T10, T11, T12. Las cuatro pantallas de mayor riesgo la renderizan en
  volumen, y T12 no puede cerrar el QA hasta que esté.
- **Se puede correr en paralelo con:** T02
- **Repo:** `/Users/lucho/Desktop/funnel/videogeneradorxd`
- **Archivos que este task puede tocar:** `src/components/JobCard.tsx`. **Uno solo.**

Leé `00-PLAN-REDISENO-UI.md` completo. Tus contratos son **§5, §6 y la tabla de §3** (los tres
detalles del modelo de datos: `candidates`, `error` en jobs que no fallaron, y `status`).

---

## 1. Objetivo

544 líneas reescritas sobre las primitivas, con la **misma interfaz `Props`** que tiene hoy.

Es el componente que aparece hasta 95 veces en una pantalla, así que además del look importa que no
sea caro: nada de animaciones infinitas por tarjeta, nada de `<video>` con `autoplay`.

**Esta task no cambia props, no cambia qué endpoints llama, y no toca ninguna pantalla.**

---

## 2. Antes de escribir

**Leé `src/components/JobCard.tsx` completo** y anotá dos cosas:

1. **La interfaz `Props` (línea ~25).** Es contrato: 4 pantallas la usan.
2. **`fileUrl(projectId, rel)` (línea ~64).** Arma la URL de `/api/files/` con el cache-busting
   `?v=<updatedAt>`. **Copiala tal cual.** Ese `?v=` está ahí por un bug real y documentado: sin él,
   al regenerar una imagen el browser servía la vieja de cache y parecía que la regeneración no había
   hecho nada. Lo mismo con el `key={url}` en los `<img>` y `<video>`.

Lo que **no** copiar: el switch de estados y los colores literales. Eso va por `ui-tokens`.

---

## 3. Lo que la tarjeta tiene que comunicar, en orden de prioridad

Hoy todo tiene el mismo peso visual y por eso no se lee. La jerarquía nueva:

1. **La imagen o el video.** Es el contenido; que ocupe el espacio.
2. **El estado**, con `Badge` y su ícono. Con ícono además de color, para que no dependa solo del
   color (hoy depende solo del color, que es inaccesible).
3. **El label del job** (`refId`) en `font-mono`, porque es un identificador.
4. **Las variantes**, cuando hay más de una: la elegida con borde de acento.
5. **Las acciones**, agrupadas y con la primaria distinguida.
6. **El prompt y el JSON**, colapsados por defecto. Hoy compiten con todo lo demás.

---

## 4. Los tres casos que hay que mostrar bien y hoy no se ven

| Caso | Qué tiene que pasar | Por qué |
|---|---|---|
| Menos candidatas que `variants` (ej. 1 de 2) | Se muestra el conteo real y la nota de `job.error`, **sin pintar la tarjeta como fallada** | Es un estado legítimo: la cuota del modelo rechazó una variante. El job sigue siendo aprobable. Ver §3 del plan. |
| `job.error` poblado en un job `awaiting_approval` o `done` | Se muestra como **nota**, no como error | `error` se usa como campo informativo. El estado sale de `status`, nunca de `error`. |
| `attempts > 1` | Se muestra el número de intento | Hoy no se ve, y es la única señal de que hubo 429 y reintentos. |

---

## 5. Rendimiento, que acá sí importa

- Los `<video>` con `preload="none"` y `poster`. Hoy la pantalla de 95 clips lagea porque monta todos
  los videos.
- Nada de `animate-pulse` por tarjeta salvo la que está en `generating`. 95 pulsos simultáneos comen
  frames.
- La tarjeta va memoizada (`React.memo`) si el padre la renderiza en lista. Verificá que las props no
  incluyan objetos nuevos en cada render, o el memo no sirve para nada.

---

## 6. Verificación

```bash
cd /Users/lucho/Desktop/funnel/videogeneradorxd

# 1 — typecheck: si cambiaste Props, las 4 pantallas revientan acá
rm -rf .next && npx tsc --noEmit
# esperado: sin salida, exit 0

# 2 — build
npm run build 2>&1 | tail -3
# esperado: sin "Failed to compile"

# 3 — el cache-busting sigue ahi (si no, regenerar parece no hacer nada)
grep -n "?v=" src/components/JobCard.tsx
# esperado: al menos 1 resultado, dentro de fileUrl

# 4 — key en los medios, por el mismo motivo
grep -cE "key=\{.*url|key=\{url" src/components/JobCard.tsx
# esperado: >= 1

# 5 — no inventaste un switch de estados
grep -n "awaiting_approval" src/components/JobCard.tsx
# esperado: sin resultados (el estado sale de estadoDeJob)

# 6 — endpoints intactos: JobCard llama a /api/files y /api/prompt-template
bash tasks/_verificacion-endpoints.sh
# esperado exactamente: SIN REGRESIONES

# 7 — cero colores literales
grep -E "#[0-9a-fA-F]{3,6}" src/components/JobCard.tsx || echo "sin colores literales"
# esperado exactamente: sin colores literales
```

A mano, y esto no se puede saltear:

1. Abrí un proyecto con **2 variantes** por imagen. Tienen que verse las dos, la elegida con borde de
   acento, y el botón de elegir la otra tiene que funcionar.
2. Buscá o generá un job con **1 de 2 variantes** (pasa solo con la cuota apretada). La tarjeta **no**
   puede verse como fallada, y la nota tiene que explicar el conteo.
3. Abrí el pipeline del VSL de 95 clips y scrolleá. Si lagea, el `preload="none"` no está puesto.

---

## 7. Cuándo parar

**Bloqueante, pará y avisá:**

- No podés reproducir un comportamiento actual sin cambiar `Props`. **No la cambies.**
- Al quitar el cache-busting o el `key`, "queda más limpio". No: rompe la regeneración, en silencio.
  Si creés que hay una forma mejor, anotala en §10, no la implementes.

**Anotalo en §10 y seguí:**

- Un dato que la tarjeta debería mostrar y la API no devuelve. **No agregues el endpoint.**
- Necesitás modificar un archivo ajeno → nunca; anotalo.
