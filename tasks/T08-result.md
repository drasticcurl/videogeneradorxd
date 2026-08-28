# T08 — Resultado del proyecto

- **Depende de:** T01, T02
- **Bloquea:** nada
- **Se puede correr en paralelo con:** T07
- **Repo:** `/Users/lucho/Desktop/funnel/videogeneradorxd`
- **Archivos que este task puede tocar:** `src/app/project/[id]/result/page.tsx`. **Uno solo.**

Leé `00-PLAN-REDISENO-UI.md` completo. Contratos: **§5**, **§6**.

---

## 1. Objetivo

356 líneas rediseñadas: la pantalla donde ves lo generado y te lo llevás.

**Esta task no cambia los endpoints ni la lógica de descarga.**

---

## 2. Antes de escribir

**Leé el archivo completo** y anotá:

1. Los endpoints: `/api/files/` y `/api/projects/:id`.
2. **El panel que muestra el JSON de todos los videos para copiar.** Es una feature que se agregó a
   propósito (el commit dice "panel para ver y copiar el JSON de todos los videos"). **Se conserva.**
3. Cómo se arman las URLs de los archivos. Si usa el cache-busting `?v=`, **copialo tal cual**: sin
   eso, un video regenerado se sirve de cache y parece que no cambió.

---

## 3. La estructura nueva

1. **Lo generado primero**, en grilla, con el formato real (9:16). Es lo que la persona vino a ver.
2. **Las acciones de exportar** visibles sin scrollear: descargar el zip es el propósito de la
   pantalla.
3. **El JSON para copiar**, colapsado. Es una herramienta, no el contenido principal.
4. **`EmptyState`** si el proyecto no generó nada todavía, con un link al pipeline.

Los `<video>` con `preload="none"` y `controls`. Nada de `autoplay`.

---

## 4. Verificación

```bash
cd /Users/lucho/Desktop/funnel/videogeneradorxd

# 1 — typecheck y build
rm -rf .next && npx tsc --noEmit && npm run build 2>&1 | tail -3
# esperado exactamente: tsc sin salida (exit 0), y el build imprime "Compiled successfully"

# 2 — la ruta sigue
npm run build 2>&1 | grep "result"
# esperado: /project/[id]/result en la lista

# 3 — endpoints
bash tasks/_verificacion-endpoints.sh
# esperado exactamente: SIN REGRESIONES

# 4 — el panel de JSON sigue existiendo
grep -icE "json|copiar" src/app/project/\[id\]/result/page.tsx
# esperado: > 0

# 5 — cero colores literales
grep -E "#[0-9a-fA-F]{3,6}" src/app/project/\[id\]/result/page.tsx || echo "limpio"
# esperado exactamente: limpio
```

A mano: abrí el resultado de un proyecto con imágenes generadas. Las miniaturas cargan, el botón de
descargar el zip funciona, y el panel de JSON copia al portapapeles.

---

## 5. Cuándo parar

**Bloqueante:** la descarga del zip deja de funcionar.

**Anotalo en §10:** un dato que la pantalla debería mostrar y la API no da. Necesitás modificar un
archivo ajeno → nunca; anotalo.
