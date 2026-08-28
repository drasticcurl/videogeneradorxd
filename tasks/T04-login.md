# T04 — Login: la primera pantalla, y la que prueba el sistema

- **Depende de:** T01
- **Bloquea:** nada
- **Se puede correr en paralelo con:** T05, T06
- **Repo:** `/Users/lucho/Desktop/funnel/videogeneradorxd`
- **Archivos que este task puede tocar:** `src/app/login/page.tsx`,
  `src/app/login/LoginForm.tsx`. Nada más.

Leé `00-PLAN-REDISENO-UI.md` completo. Tu contrato es **§5** (primitivas).

Es la pantalla más chica (53 + 156 líneas) y va primero a propósito: si la ergonomía de las
primitivas de T01 tiene un problema, es mucho más barato descubrirlo acá que en el pipeline de 1187
líneas. **Si algo de T01 no alcanza, anotalo en §10: le sirve a las 7 tasks que vienen.**

---

## 1. Objetivo

- Login rediseñado, con `Card`, `Select`, `Input` y `Button` de T01.
- Estados de error y de carga con las primitivas, no a mano.
- **El comportamiento de auth queda idéntico.**

**Esta task no toca la lógica de login, ni el fetch, ni la navegación posterior.**

---

## 2. Lo que NO se puede tocar, y por qué

**Leé `LoginForm.tsx` completo, incluido el comentario largo del handler.** Ahí está documentado un
bug real: la versión anterior hacía `router.refresh()` y `router.push("/")`, y como `/login` llama
`redirect("/")` cuando ya hay cookie, el redirect caía dentro de un refresh y Next lo reportaba como
error de render. **Con la clave correcta salía un error del server; con la clave mal, andaba bien.**

Por eso hoy hay `window.location.assign("/")`. **No lo cambies por `router.push`.** Si te parece
mejorable, va a §10.

Tampoco se toca:

- El POST a `/api/login` ni su forma de body.
- El `select` de usuarios que viene por props desde el server (`listUsers()`).
- El chequeo `isConfigured()` de `page.tsx` y su mensaje de "falta AUTH_SECRET".
- Los `autoComplete="username"` y `"current-password"`: los gestores de contraseñas dependen de eso.
- El `name` de los campos.

---

## 3. Lo que sí se rediseña

- La tarjeta centrada, con el `max-w-sm` que ya tiene. Es el único caso de la app donde centrar está
  bien: es una pantalla de un solo propósito.
- El error va en el `Input` (prop `error`), no en un `<p>` suelto arriba del botón. Así queda pegado
  al campo que falló y lo lee un lector de pantalla por `aria-describedby`.
- El botón usa `loading`, que **no cambia el texto** (§5 regla 1).
- El mensaje de 429 del rate limit se muestra como error del formulario, con los segundos.
- Agregá el ícono de Phosphor en el botón, uno solo, discreto.

**El texto "Herramienta interna. Generar consume cuota facturable de Vertex AI." se mantiene.** Es
información real y útil.

---

## 4. Verificación

```bash
cd /Users/lucho/Desktop/funnel/videogeneradorxd

# 1 — typecheck y build
rm -rf .next && npx tsc --noEmit && npm run build 2>&1 | tail -3
# esperado exactamente: tsc sin salida (exit 0), y el build imprime "Compiled successfully"

# 2 — la ruta /login sigue compilada
npm run build 2>&1 | grep -E "/login"
# esperado: la linea de /login en la lista de rutas

# 3 — el fetch al login sigue ahi
bash tasks/_verificacion-endpoints.sh
# esperado exactamente: SIN REGRESIONES

# 4 — la navegacion por carga completa NO se cambio por router.push
grep -n "window.location.assign" src/app/login/LoginForm.tsx
# esperado: 1 resultado. Si desaparecio, se reintrodujo el bug del login.

# 5 — los autoComplete siguen (los gestores de password dependen de esto)
grep -cE 'autoComplete="(username|current-password)"' src/app/login/LoginForm.tsx
# esperado exactamente: 2

# 6 — cero colores literales
grep -rE "#[0-9a-fA-F]{3,6}" src/app/login/ || echo "sin colores literales"
# esperado exactamente: sin colores literales
```

A mano, con la app corriendo, y **los 4 casos**:

1. Clave **incorrecta** → error abajo del campo, en rojo, y el foco queda usable.
2. Clave **correcta** → entra a `/` y el header muestra el nombre del usuario. **Este es el caso que
   estaba roto antes; probalo sí o sí.**
3. **6 intentos fallidos seguidos** → aparece el mensaje de 429 con los segundos.
4. Con **Tab solamente**, sin mouse: se puede elegir usuario, escribir la clave y enviar. El anillo de
   foco se ve en los tres controles.

---

## 5. Cuándo parar

**Bloqueante, pará y avisá:**

- Una primitiva de T01 no te deja reproducir el formulario sin cambiar su firma.
- El caso 2 de la verificación a mano falla. Es el login: si no entra, la app no se usa.

**Anotalo en §10 y seguí:**

- **Cualquier fricción de las primitivas de T01.** Esta task es la que las estrena; lo que anotes
  acá le ahorra el problema a las 7 siguientes.
- Necesitás modificar un archivo ajeno → nunca; anotalo.
