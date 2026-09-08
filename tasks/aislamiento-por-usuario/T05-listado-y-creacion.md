# T05 — Listado y creación: donde el dueño nace y donde se filtra

- **Depende de:** T01 (importás `sessionUser` de `src/lib/ownership.ts`)
- **Bloquea:** T08
- **Se puede correr en paralelo con:** T02, T03, T04, T06, T07
- **Repo:** `/Users/lucho/Desktop/funnel/videogeneradorxd`
- **Archivos que este task puede tocar** (2, y ninguno más):

```
src/app/api/projects/route.ts   (GET lista, POST crea)
src/app/api/imagenes/route.ts   (POST crea un proyecto de solo imagenes)
```

Leé `00-PLAN-AISLAMIENTO-USUARIO.md` completo. Tu contrato es **§4** (`sessionUser`) y **§5.3**.

**Esta es la task que hace que el pedido original se cumpla.** "Que los proyectos nuevos estén por
usuario" es literalmente el `POST` de tus dos archivos; y `GET /api/projects` es la lista que hoy
muestra los proyectos del otro en la home, en `/imagenes` y en el selector de `/batch`.

---

## 1. Objetivo

Cuando termines:

- `GET /api/projects` devuelve **solo** los proyectos del usuario logueado. Sin sesión: 401.
- `POST /api/projects` y `POST /api/imagenes` graban `owner` con el usuario de la sesión. Sin sesión:
  401 **y no se crea nada** (ni el registro, ni la carpeta en disco, ni el manifest).
- Ninguno de los dos lee `owner` del body.

**Este task no cambia la forma del resumen que devuelve `GET` (los campos `id`, `name`, `status`,
`createdAt`, `updatedAt`, `clipCount`, `imageCount`, `soloImagenes`), no toca el schema del plan, y no
modifica `src/lib/db.ts`.**

---

## 2. `GET /api/projects` — filtrar en la ruta, no en `db.ts`

Hoy (`src/app/api/projects/route.ts:16-38`):

```ts
const projects = projectsDb.list().map((p) => ({ ...resumen... }));
```

`projectsDb.list()` sigue devolviendo todo: `src/lib/db.ts` está en la lista de intocables y la capa
de datos no tiene que saber de usuarios. **El filtro va en la ruta, antes del `.map()`**:

1. `const user = sessionUser()`. Si es `null` → 401 con `{ error }`.
2. Filtrá por `p.owner === user`.
3. El `.map()` que arma el resumen queda **igual**, sin agregar `owner` al objeto de salida.

**No agregues `owner` al resumen.** El cliente ya sabe quién es (el layout se lo pasa al
`SessionBar`), y si la lista solo trae lo tuyo el campo es información redundante que además habría
que agregar al tipo del store y a las 2 pantallas que lo consumen — trabajo de más para nada.

**El filtro es `=== user`, no `!== otro` ni "sin dueño también".** Un proyecto con `owner: undefined`
**no** matchea, y eso es deliberado (D2 del plan): si `undefined` significara "de todos", cualquier
proyecto creado por un camino que se olvide de setear el dueño quedaría visible para los dos, que es
el bug que este módulo cierra. Los proyectos viejos se arreglan con la migración, no acá.

---

## 3. Los dos `POST` — el dueño sale de la cookie

En los dos casos, el guard va **antes** de validar el plan y antes de tocar el filesystem:

```ts
const user = sessionUser();
if (!user) return ok({ error: "No autenticado." }, { status: 401 });
```

**Antes de tocar el filesystem, y eso importa:** las dos rutas hacen `ensureProjectDirs(id)` y
`writeManifest(...)`. Si el chequeo fuera después, un request sin sesión dejaría **carpetas huérfanas**
en `OUTPUT_DIR` que nadie va a limpiar nunca, porque no hay ningún `ProjectRecord` que las
referencie.

Después, en el objeto `ProjectRecord` que cada ruta construye, agregá:

```ts
owner: user,
```

**Nunca `owner: body.owner ?? user`** ni ninguna variante que mire el body (D3). Si el body trae
`owner`, se ignora en silencio. Un `owner` que viene del cliente permite que Ivan cree proyectos a
nombre de Lucho.

`src/app/api/imagenes/route.ts` — **leelo completo antes de escribir.** Construye su propio
`ProjectRecord` (no reusa el de `projects/route.ts`) y ahí también va el campo. Si construye el record
en más de un lugar, el campo va en **todos**.

---

## 4. Verificación

Nada de esto es opcional. Un task que no corre su verificación no está terminado, y "compila" no es
verificación.

```bash
cd /Users/lucho/Desktop/funnel/videogeneradorxd

# 1 — los dos archivos usan sessionUser
grep -c "sessionUser()" src/app/api/projects/route.ts src/app/api/imagenes/route.ts
# esperado: projects/route.ts con 2 o mas (GET y POST), imagenes/route.ts con 1 o mas

# 2 — el GET filtra por owner
grep -nE "owner === " src/app/api/projects/route.ts
# esperado: 1 resultado, comparando contra el usuario de la sesion

# 3 — los dos POST graban el owner
grep -nE "^\s+owner: " src/app/api/projects/route.ts src/app/api/imagenes/route.ts
# esperado exactamente: 1 resultado en cada archivo

# 4 — NUNCA se lee owner del body (D3)
grep -nE "(body[?]?\.owner|body\[.owner.\]|owner.*\?\?.*body)" \
  src/app/api/projects/route.ts src/app/api/imagenes/route.ts || echo "el owner no viene del body"
# esperado exactamente: el owner no viene del body

# 5 — el chequeo va ANTES de tocar el filesystem
for f in src/app/api/projects/route.ts src/app/api/imagenes/route.ts; do
  s=$(grep -n "sessionUser()" "$f" | tail -1 | cut -d: -f1)
  d=$(grep -n "ensureProjectDirs" "$f" | head -1 | cut -d: -f1)
  [ -n "$d" ] && { [ "$s" -lt "$d" ] && echo "ok ${f#src/app/api/} ($s < $d)" || echo "REVISAR ${f#src/app/api/}"; }
done
# esperado exactamente: 2 lineas "ok ...", ninguna "REVISAR"

# 6 — sin sesion, los dos archivos contestan 401 (no 500 ni 200)
grep -cE "status: 401" src/app/api/projects/route.ts src/app/api/imagenes/route.ts
# esperado: 1 o mas en cada archivo
#   Un 500 aca seria un bug: "no hay sesion" es un caso esperado, no un error del server.

# 7 — typecheck
rm -rf .next && npx tsc --noEmit
# esperado: sin salida, exit 0

# 8 — tus 2 rutas en verde
bash tasks/aislamiento-por-usuario/_verificacion-aislamiento.sh 2>&1 \
  | grep -E "^\s+(OK|PENDIENTE).*(projects/route.ts|imagenes/route.ts)"
# esperado exactamente: 2 lineas, las dos empezando con "OK"

# 9 — no rompiste ningun endpoint
bash tasks/_verificacion-endpoints.sh | tail -1
# esperado exactamente: SIN REGRESIONES
```

A mano, con la app corriendo en local y **al menos dos `PASSWORD_*` en `.env.local`** (si no hay
usuarios, no se puede probar nada de esto):

1. Entrá como usuario A, creá un proyecto. Miralo en la home.
2. Salí, entrá como usuario B. **La home no tiene que mostrar el proyecto de A.**
3. Como B, creá otro. Volvé a A: A ve el suyo y no el de B.
4. Mirá `data/db.json`: los dos registros nuevos tienen `owner` con el nombre correcto, en minúsculas.

---

## 5. Cuándo parar

**Bloqueante, pará y avisá:**

- `sessionUser()` no existe o no tiene la firma de §4 → T01 no terminó. **No leas la cookie a mano
  con `cookies()` en la ruta**: quedarían dos formas distintas de resolver el usuario y una de las dos
  se va a desincronizar.
- `src/app/api/imagenes/route.ts` construye el `ProjectRecord` en un helper compartido que **no** está
  en tu lista de archivos. Pará y avisá: hay que decidir quién lo escribe antes de que dos tasks lo
  toquen.

**Anotalo en §10 del plan y seguí:**

- Te parece que el `GET` debería paginar ahora que filtra. Anotalo: es otro cambio.
- Encontrás otro lugar del repo que cree un `ProjectRecord` (por ejemplo un script de `scripts/`).
  Anotalo con el path: nacería sin dueño y quedaría invisible.
- Necesitás modificar un archivo ajeno → **nunca**; anotalo.
