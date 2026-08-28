# T06 — Imágenes: la pantalla más usada

- **Depende de:** T01, T02 (`ModelSelectorBar`)
- **Bloquea:** nada
- **Se puede correr en paralelo con:** T04, T05
- **Repo:** `/Users/lucho/Desktop/funnel/videogeneradorxd`
- **Archivos que este task puede tocar:** `src/app/imagenes/page.tsx`,
  `src/app/imagenes/ImagenesBoard.tsx`. Nada más.

Leé `00-PLAN-REDISENO-UI.md` completo. Contratos: **§5**, **§6** y la tabla de **§3** (variantes
incompletas son estado legítimo).

---

## 1. Objetivo

34 + 459 líneas rediseñadas. Es la pantalla que el usuario usa más: pega prompts, genera con N
variantes, elige la que queda y varía las que no le gustan.

**Esta task no cambia los endpoints, no cambia el formato de los prompts, y no toca la config del
pipeline.**

---

## 2. Antes de escribir

**Leé `ImagenesBoard.tsx` completo** y anotá:

1. Los **4 endpoints**: `POST /api/imagenes`, `GET /api/projects/:id/jobs`,
   `POST /api/jobs/:id/approve`, `POST /api/jobs/:id/prompt`.
2. **El polling y su corte.** El intervalo se guarda en un `ref` a propósito y **se apaga cuando no
   queda nada en curso**: la pantalla puede quedar abierta horas. Si lo movés a `useState`, se
   reinicia en cada render y le pega a la API mucho más seguido de lo que dice el número.
3. **`editando` está separado de `prompts`** a propósito: si fuera uno solo, lo que estás tipeando se
   perdería cada vez que llega una respuesta del polling.

---

## 3. El caso que esta pantalla tiene que mostrar bien

**Salieron menos variantes de las pedidas.** Pasa seguido: la cuota de los modelos de imagen 3.x es
apretada y rechaza la segunda variante. Cuando pasa:

- Se muestra el conteo real: `1 de 2`.
- La nota de `job.error` explica por qué, **sin que la tarjeta se vea fallada**.
- El botón "Variar" es la salida: reintenta.

Hoy esto se ve como si todo hubiera salido bien. Es el bug de percepción más importante de la
pantalla.

---

## 4. La estructura nueva

1. **Formulario arriba**: nombre, modelo, variantes, prompts, negative prompt. El preview del nombre
   de archivo (`crema_manos_01.png`) se mantiene: es información útil y concreta.
2. **El contador de costo** al lado del botón: `12 prompts × 2 = 24 imágenes`. Se mantiene, en mono.
3. **Los resultados en grilla**, no en lista vertical de bloques. Cada prompt con sus variantes en
   miniatura, el prompt editable colapsado, y las acciones.
4. **`EmptyState`** antes de la primera generación, explicando el flujo en una línea.

Las miniaturas en `aspect-[9/16]`, que es el formato real, y la elegida con borde de acento (`amber`
= "esta es la que queda", coherente con D6).

---

## 5. El aviso del gate por lotes

Ver **P-01** del plan. Con más de 5 prompts, la cola se frena esperando aprobación y **parece que se
colgó**. Mostrá un aviso con el conteo (`5 de 12 listas. Aprobá para que siga el resto.`) y un botón
que apruebe las visibles.

**No cambies `PIPELINE_APPROVAL_BATCH`**: es config de otro dominio y `src/lib/config.ts` es
intocable.

---

## 6. Verificación

```bash
cd /Users/lucho/Desktop/funnel/videogeneradorxd

# 1 — typecheck y build
rm -rf .next && npx tsc --noEmit && npm run build 2>&1 | tail -3
# esperado exactamente: tsc sin salida (exit 0), y el build imprime "Compiled successfully"

# 2 — la ruta sigue
npm run build 2>&1 | grep "/imagenes"
# esperado: la linea de /imagenes

# 3 — los 4 endpoints siguen
bash tasks/_verificacion-endpoints.sh
# esperado exactamente: SIN REGRESIONES

# 4 — el polling sigue en un ref y sigue cortandose
grep -n "useRef\|clearInterval" src/app/imagenes/ImagenesBoard.tsx
# esperado: al menos un useRef para el intervalo y al menos un clearInterval

# 5 — cero colores literales
grep -rE "#[0-9a-fA-F]{3,6}" src/app/imagenes/ || echo "limpio"
# esperado exactamente: limpio
```

A mano, con la app corriendo. **Esto cuesta plata real (unos 4 centavos por imagen), así que hacelo
con 2 prompts y 2 variantes, no más:**

1. Generá 2 prompts × 2 variantes. Verificá que aparecen las 4 miniaturas.
2. Elegí la variante 2 de uno. El borde de acento tiene que moverse.
3. Editá un prompt y dale Variar. Tiene que volver a `generando`.
4. Si a alguno le sale **1 de 2**, verificá que **no** se ve como fallado y que la nota explica.
5. Con la pestaña abierta y todo terminado, mirá la consola de red: el polling tiene que haber
   **parado**. Si sigue pegando cada 3s, se rompió el corte.

---

## 7. Cuándo parar

**Bloqueante, pará y avisá:**

- El polling no se puede reproducir sin moverlo a `useState`. No lo muevas.
- Al reescribir se pierde la separación entre `editando` y `prompts`.

**Anotalo en §10 y seguí:**

- El aviso del gate por lotes (P-01) si te parece que necesita otra solución.
- Necesitás modificar un archivo ajeno → nunca; anotalo.
