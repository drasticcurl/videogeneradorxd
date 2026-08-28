# T09 — Deck de revisión

- **Depende de:** T01, T02, T03
- **Bloquea:** nada
- **Se puede correr en paralelo con:** T10, T11
- **Repo:** `/Users/lucho/Desktop/funnel/videogeneradorxd`
- **Archivos que este task puede tocar:** `src/app/batch/review/page.tsx`,
  `src/app/batch/review/ReviewDeck.tsx`. Nada más.

Leé `00-PLAN-REDISENO-UI.md` completo. Contratos: **§5**, **§6** y la tabla de **§3**.

**Esta es una de las tres tasks de mayor riesgo.** Acá se aprueba y se regenera, o sea que un botón
que deja de funcionar cuesta plata o trabajo perdido. Va en la última ola por eso: cuando te toca, el
sistema ya está probado en 5 pantallas.

---

## 1. Objetivo

19 + 869 líneas rediseñadas. Es donde se revisa lote por lote lo generado y se decide qué aprobar y
qué regenerar.

**Esta task no cambia los 7 endpoints, no cambia la lógica de aprobación ni de regeneración, y no
toca el store.**

---

## 2. Antes de escribir, y esto no es opcional

**Leé `ReviewDeck.tsx` completo, las 869 líneas.** Es la pantalla con más handlers de la app. Anotá:

1. **Los 7 endpoints** que llama y qué hace cada uno. Son más que en cualquier otra pantalla.
2. **Qué hace cada botón de aprobar y regenerar**, y con qué payload. Un payload que cambia de forma
   es un 400 silencioso.
3. Qué hacen `EmptyState`, `ReviewCard` y `ScriptPanel`, que son internos del archivo. **Ojo:** ya hay
   un `EmptyState` local acá; al usar el de T01, renombralo o quitalo, pero **no dejes los dos con el
   mismo nombre**.
4. Si hay selección múltiple, **cómo se guarda**. Es fácil romperla al reorganizar el JSX.

---

## 3. La estructura nueva

1. **Qué estás revisando y cuánto falta**, arriba y siempre visible: `12 de 40 revisadas`.
2. **La tarjeta grande**, con el medio ocupando el espacio.
3. **Aprobar y regenerar** como las dos acciones principales, distinguidas entre sí. Aprobar es
   `primary`; regenerar es `secondary`, porque cuesta plata.
4. **El script y el prompt** colapsados.
5. Navegación con teclado entre tarjetas si ya existe; **si no existe, no la agregues** (sería
   funcionalidad nueva): anotala en §10.

---

## 4. El caso de las variantes incompletas

Igual que en T06: `1 de 2` es estado legítimo, no falla. La nota de `job.error` se muestra como nota.
Ver §3 del plan.

---

## 5. Verificación

```bash
cd /Users/lucho/Desktop/funnel/videogeneradorxd

# 1 — typecheck y build
rm -rf .next && npx tsc --noEmit && npm run build 2>&1 | tail -3
# esperado exactamente: tsc sin salida (exit 0), y el build imprime "Compiled successfully"

# 2 — la ruta sigue
npm run build 2>&1 | grep "batch/review"
# esperado: /batch/review en la lista

# 3 — LOS 7 ENDPOINTS. Es el paso mas importante de esta task
bash tasks/_verificacion-endpoints.sh
# esperado exactamente: SIN REGRESIONES
#   si dice PERDIO, un boton quedo sin hacer nada y no lo vas a ver hasta usarlo

# 4 — contá los fetch a mano tambien, porque el script compara endpoints y no cantidad
grep -c "fetch(" src/app/batch/review/ReviewDeck.tsx
# esperado: 7. Si bajo, se perdio un handler.

# 5 — no invadiste ownership
git diff --name-only src/app/batch/videos/ src/app/batch/BatchBoard.tsx
# esperado: sin salida

# 6 — cero colores literales
grep -rE "#[0-9a-fA-F]{3,6}" src/app/batch/review/ || echo "limpio"
# esperado exactamente: limpio
```

A mano, con un proyecto real, y **probá cada botón uno por uno**:

1. Aprobar una imagen → el estado pasa a `Listo` y la tarjeta lo refleja.
2. Regenerar una → vuelve a `Generando`.
3. Si hay selección múltiple, seleccioná 2 y aprobá el lote.
4. Si hay aprobar-todo, probalo con 2 items.
5. Una tarjeta con `1 de 2` variantes no se ve como fallada.

**No declares terminada la task sin haber apretado cada botón.** El typecheck no detecta un handler
que quedó desconectado.

---

## 6. Cuándo parar

**Bloqueante, pará y avisá:**

- Un botón no se puede reconectar sin cambiar el payload de un endpoint.
- El paso 3 o 4 de la verificación baja de 7.
- Se rompe la selección múltiple.

**Anotalo en §10 y seguí:** navegación con teclado si no existe hoy. Necesitás modificar un archivo
ajeno → nunca; anotalo.
