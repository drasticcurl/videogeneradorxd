# T12 — Limpieza: borrar los alias viejos y el QA final

- **Depende de:** T01, T02, T03, T04, T05, T06, T07, T08, T09, T10, T11 — todas, y todas tienen que
  estar verificadas antes de que esta arranque.
- **Bloquea:** nada
- **Se puede correr en paralelo con:** **corre sola. No paralelizar con nada.**
- **Repo:** `/Users/lucho/Desktop/funnel/videogeneradorxd`
- **Archivos que este task puede tocar:** `tailwind.config.ts` (**solo para borrar los alias**),
  `tasks/_verificacion-*.{sh,mjs}`. Nada más.

Leé `00-PLAN-REDISENO-UI.md` completo, sobre todo **§9** (criterios de aceptación) y **§10**
(preguntas abiertas).

---

## 1. Objetivo

- Los alias `ink`, `panel` y `accent` borrados de `tailwind.config.ts`, con la prueba de que nadie los
  usa.
- Los 10 criterios de aceptación de §9 verificados y su salida pegada.
- Las preguntas abiertas de §10 actualizadas con lo que las tasks anotaron.

**Esta task no rediseña nada y no arregla bugs de otras tasks: los reporta.**

---

## 2. Borrar los alias, en este orden

T01 dejó `ink`, `panel` y `accent` como alias de transición (D7) para que la app no quedara sin
estilos mientras las pantallas se migraban de a una. Ya no hacen falta. Pero **primero se prueba que
nadie los usa, después se borran**:

```bash
# 1 — cuantas referencias quedan
grep -rnE "\b(bg|text|border|ring|fill|stroke)-(ink|panel|accent)\b" src/ || echo "ninguna"
# esperado exactamente: ninguna
```

Si hay resultados, **no borres nada**: la pantalla que los usa quedó sin migrar. Anotá qué archivo es
y avisá. Borrar los alias con referencias vivas deja esa pantalla sin color y no rompe el build.

Recién con `ninguna`, saca las tres líneas del config y volvé a correr el build.

---

## 3. Verificación: los 10 criterios de §9

Corré cada uno y **pegá la salida**. No es opcional.

```bash
cd /Users/lucho/Desktop/funnel/videogeneradorxd

# 1 — typecheck
rm -rf .next && npx tsc --noEmit
# esperado: sin salida, exit 0

# 2 — build, y LAS 8 RUTAS presentes
npm run build 2>&1 | grep -E "ƒ /" | grep -vE "/api/"
# esperado: /, /login, /imagenes, /batch, /batch/review, /batch/videos,
#           /project/[id]/pipeline, /project/[id]/result
#           Si falta una, un archivo quedo mal renombrado.

# 3 — inventario
bash tasks/_verificacion-inventario.sh
# esperado exactamente: la ultima linea dice "INVENTARIO COMPLETO" y exit 0

# 4 — contraste
node tasks/_verificacion-contraste.mjs
# esperado exactamente: FALLOS: 0

# 5 — EL MAS IMPORTANTE: ninguna pantalla perdio una llamada a la API
bash tasks/_verificacion-endpoints.sh
# esperado exactamente: SIN REGRESIONES

# 6 — cero colores literales en toda la UI
grep -rE "#[0-9a-fA-F]{3,6}" src/ --include=*.tsx || echo "sin colores literales"
# esperado exactamente: sin colores literales

# 7 — nada por debajo de 12px
grep -rE "text-\[1[01]px\]|text-\[[0-9]px\]" src/ --include=*.tsx || echo "sin tipografia diminuta"
# esperado exactamente: sin tipografia diminuta

# 8 — un solo lugar que menciona los estados
grep -rln "awaiting_approval" src/ --include=*.tsx --include=*.ts | grep -v "lib/ui-tokens.ts"
# esperado: solo archivos de src/lib/ que NO son de UI (queue, pipeline, types).
#           Ningun .tsx tiene que aparecer.

# 9 — los intocables siguen intactos respecto de main
git diff --stat main -- src/lib/jobs/ src/lib/providers/ src/lib/config.ts src/lib/schema.ts \
  src/lib/storage.ts src/lib/db.ts src/lib/auth.ts src/middleware.ts src/app/api/ src/store/
# esperado: SIN SALIDA. Si hay algo, una task se salio de su fila (§8).

# 10 — no quedaron dependencias sin declarar
npm ls --depth=0 2>&1 | grep -i "missing\|invalid" || echo "dependencias OK"
# esperado exactamente: dependencias OK
```

---

## 4. El QA a mano, con la app corriendo

Lo que no se puede verificar con `curl`. Andá pantalla por pantalla:

| Pantalla | Qué probar |
|---|---|
| `/login` | Clave mal → error. Clave bien → **entra** y el header muestra el usuario. |
| `/` | Los dos modos. Subir un avatar y editar su `id`. |
| `/imagenes` | Generar 2×2, elegir variante, variar una. |
| `/batch` | Cambiar de proyecto, el progreso suma bien. |
| `/batch/review` | **Cada botón de aprobar y regenerar.** |
| `/batch/videos` | Regenerar pide confirmación. |
| `/project/[id]/pipeline` | **Editar un prompt, Guardar, recargar: el cambio sigue.** |
| `/project/[id]/result` | Descargar el zip. Copiar el JSON. |

Y transversal, en todas:

1. **Con Tab solamente**, sin mouse: se puede llegar a todos los controles y el foco se ve.
2. El link activo del nav se distingue en cada pantalla.
3. Con "reducir movimiento" del sistema activado, nada pulsa ni se mueve.
4. En una ventana angosta (400px), ninguna pantalla desborda horizontalmente.
5. Los estados vacíos: entrá a una pantalla sin datos y verificá que dice qué hacer, no que queda en
   blanco.

---

## 5. Cerrar las preguntas abiertas

Leé §10 del plan y actualizá cada una con lo que las tasks anotaron. Las que ya estaban sembradas:

- **P-01** aviso del gate por lotes: ¿la solución de T06 alcanzó?
- **P-02** el precio de video desactualizado: sigue abierta, es config.
- **P-03** `FlowGraph` con 95 clips: T02 tenía que anotar el número de nodos. **Si no lo anotó,
  pedilo.**
- **P-04** las decisiones que se tomaron por el usuario: D1 y D2 son las que conviene confirmar.

Cualquier pregunta nueva que las tasks hayan agregado, dejala con su estado.

---

## 6. Cuándo parar

**Bloqueante, pará y avisá:**

- El paso 5 (endpoints) o el 9 (intocables) del QA no dan lo esperado. **Significa que una task rompió
  algo funcional o se salió de su fila.**
- Falta una de las 8 rutas en el build.
- Cualquiera de los dos casos marcados en negrita del QA a mano falla (entrar al login, persistir una
  edición del pipeline).

**Anotalo en §10 y seguí:**

- Detalles visuales de una pantalla ajena. **No los arregles vos:** no es tu fila. Anotalos con el
  archivo y qué viste.
- Deuda que quedó y vale la pena hacer después.
