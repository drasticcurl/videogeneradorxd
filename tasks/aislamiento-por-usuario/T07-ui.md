# T07 — UI: que el cartel deje de mentir y que un proyecto ajeno no rompa la pantalla

- **Depende de:** T01 (solo por orden: no importás nada de `ownership.ts`)
- **Bloquea:** T08
- **Se puede correr en paralelo con:** T02, T03, T04, T05, T06
- **Repo:** `/Users/lucho/Desktop/funnel/videogeneradorxd`
- **Archivos que este task puede tocar** (3, y ninguno más):

```
src/app/batch/BatchBoard.tsx                    (el cartel de missingIds)
src/app/project/[id]/pipeline/page.tsx          (el 404 al abrir un proyecto ajeno)
src/app/project/[id]/result/page.tsx            (idem)
```

Leé `00-PLAN-AISLAMIENTO-USUARIO.md` completo. Tu contrato es **§5.5** y la decisión **D7**.

**Sos la única task de la ola 2 que no toca el backend.** No importás `ownership.ts`: es código de
servidor y estos tres archivos son `"use client"`. Tu trabajo es que la UI no mienta y no se rompa
cuando el backend empiece a devolver 404.

---

## 1. Objetivo

- El cartel del lote no afirma más que los proyectos "los borraste", y **no revela** si un id ajeno
  existe o no.
- Abrir `/project/<id ajeno>/pipeline` o `/result` muestra un mensaje legible, no una pantalla a medio
  cargar ni un error crudo.
- Ninguna pantalla pierde un `fetch`.

**Este task no cambia ningún endpoint, no agrega estado global, no toca `src/app/page.tsx` ni
`src/app/imagenes/ImagenesBoard.tsx`, y no rediseña nada.**

---

## 2. Lo que NO se toca, y por qué

`src/app/page.tsx` y `src/app/imagenes/ImagenesBoard.tsx` **no necesitan cambios y están en la lista
de intocables de §7.** Los dos llaman `GET /api/projects`, que después de T05 devuelve solo lo tuyo:
la lista simplemente viene más corta. Y los dos **ya tienen `EmptyState`** (`page.tsx:1046`,
`ImagenesBoard.tsx:880`), verificado, así que un usuario con cero proyectos ya ve un estado vacío
decente. No hay nada que arreglar ahí.

`ReviewDeck.tsx` y `VideoDeck.tsx` tampoco: leen `/api/batch`, que después de T06 ya viene filtrado.

---

## 3. `BatchBoard.tsx` — el cartel de `missingIds`

**Leé las líneas 596-604 completas antes de escribir.** Hoy dicen:

> Estos proyectos ya no existen (los borraste): `<ids>` [quitarlos del tablero]

Después de T06, `missingIds` trae **dos cosas mezcladas a propósito**: ids borrados e ids de otro
usuario. Entonces el texto actual tiene dos problemas:

1. **Es falso.** "Los borraste" no es cierto para un proyecto de Ivan que existe y está entero.
2. **Y no se puede arreglar diciendo la verdad.** Si dijera "no son tuyos", estaría confirmando que el
   proyecto existe — que es exactamente lo que D4 no permite filtrar. Los 404 del backend están
   diseñados para no distinguir los dos casos; el cartel no puede deshacer eso.

El texto nuevo tiene que ser **neutro**: describir que no están disponibles en este tablero, sin
afirmar el motivo. Redactalo vos en el tono de la app (voseo, directo, sin solemnidad).

**Lo que se conserva tal cual:**

- El componente `<Aviso tone="attention">` y su ícono.
- La lista de ids en `<code className="code">`. Sirve para que el usuario reconozca cuál sacó.
- El botón **"quitarlos del tablero"** con su `onClick` exacto
  (`setIds(ids.filter((id) => !snap.missingIds.includes(id)))`). Es la única forma de limpiar la URL
  del lote, y `setIds` es lo que reescribe el query param.
- La condición `snap && snap.missingIds.length > 0`.

---

## 4. Las dos páginas de proyecto — el 404

**Leé primero cómo cargan.** Las dos son `"use client"`, sacan `projectId` de `params.id`
(`pipeline/page.tsx:159`, `result/page.tsx:117`) y llaman al store (`useProjectStore`), que hace
`jsonFetch('/api/projects/<id>')` en `loadProject` (`src/store/useProjectStore.ts:365`).

Después de T02, ese fetch devuelve **404 con `{ error: "Proyecto no encontrado" }`** cuando el
proyecto es de otro. Hoy la app entra a esa pantalla por URL directa, así que el caso es alcanzable:
alcanza con que alguien pegue un link en un chat.

Lo que tenés que lograr: **que se vea el mensaje del error, no una pantalla vacía ni un throw sin
manejar.** El patrón que ya usa el resto de la app es `const [error, setError] = useState<string |
null>(null)` y mostrar `data.error` (está en `ReviewDeck.tsx:186`, `BatchBoard.tsx:170`,
`page.tsx:234`, `result/page.tsx:137` y ocho lugares más). **Copiá ese patrón, no inventes otro.**

**`useProjectStore.ts` no está en tu lista y no se toca.** Si `loadProject` lanza, el manejo va en la
página, con `try/catch` alrededor de la llamada. Meter el estado de error en el store lo volvería
compartido entre las dos pantallas y un error de una quedaría pegado en la otra al navegar.

Dos detalles que importan:

- **No redirijas a `/`.** Un redirect automático hace parecer que el link estaba roto; el usuario
  necesita ver que ese proyecto no está disponible para él. Dejá el mensaje y un link a la home.
- **No distingas 404 de otros errores en el texto.** Mostrá el `error` que vino del server. Si
  agregaras un caso especial tipo "este proyecto es de otro usuario", romperías D4 desde el cliente.

---

## 5. Verificación

Nada de esto es opcional. Un task que no corre su verificación no está terminado, y "compila" no es
verificación.

```bash
cd /Users/lucho/Desktop/funnel/videogeneradorxd

# 1 — el cartel ya no afirma que los borraste
grep -n "los borraste" src/app/batch/BatchBoard.tsx || echo "el texto viejo ya no esta"
# esperado exactamente: el texto viejo ya no esta

# 2 — y tampoco revela que son de otro (D4)
grep -niE "(no son tuyos|de otro usuario|ajeno|otro dueño|pertenece a)" src/app/batch/BatchBoard.tsx \
  || echo "el cartel no revela existencia"
# esperado exactamente: el cartel no revela existencia

# 3 — el boton de quitar del tablero sigue funcionando
grep -c "setIds(ids.filter((id) => !snap.missingIds.includes(id)))" src/app/batch/BatchBoard.tsx
# esperado exactamente: 1
#   Si da 0, se perdio la unica forma de limpiar el lote.

# 4 — las dos paginas manejan el error de carga
grep -c "setError" src/app/project/\[id\]/pipeline/page.tsx src/app/project/\[id\]/result/page.tsx
# esperado: 1 o mas en cada archivo

# 5 — ninguna de las dos redirige sola al inicio
grep -nE "(router\.(push|replace)\(\"/\"\)|location\.assign\(\"/\"\))" \
  src/app/project/\[id\]/pipeline/page.tsx src/app/project/\[id\]/result/page.tsx \
  || echo "no hay redirect automatico"
# esperado exactamente: no hay redirect automatico

# 6 — no tocaste el store ni las dos pantallas intocables
git diff --name-only src/store/useProjectStore.ts src/app/page.tsx \
  src/app/imagenes/ImagenesBoard.tsx | grep . && echo "ERROR: tocaste un intocable" \
  || echo "intocables intactos"
# esperado exactamente: intocables intactos

# 7 — cero colores literales (convencion del rediseño anterior)
grep -rE "#[0-9a-fA-F]{3,6}" src/app/batch/BatchBoard.tsx src/app/project/\[id\]/pipeline/page.tsx \
  src/app/project/\[id\]/result/page.tsx || echo "sin colores literales"
# esperado exactamente: sin colores literales

# 8 — typecheck
rm -rf .next && npx tsc --noEmit
# esperado: sin salida, exit 0

# 9 — NO perdiste ningun fetch. Este es el que importa en una task de UI.
bash tasks/_verificacion-endpoints.sh | tail -1
# esperado exactamente: SIN REGRESIONES
```

A mano, con la app corriendo (esto no se puede verificar con `curl`):

1. `/batch?ids=<un id inventado>` → aparece el cartel nuevo, con el id listado, y **"quitarlos del
   tablero" limpia la URL**.
2. `/project/<id inventado>/pipeline` → mensaje legible, con salida a la home. No una pantalla en
   blanco, no un stack trace.
3. Lo mismo en `/project/<id inventado>/result`.
4. Con teclado solo: el link de salida del mensaje de error es alcanzable con Tab y se activa con
   Enter.

---

## 6. Cuándo parar

**Bloqueante, pará y avisá:**

- Manejar el error obliga a cambiar `useProjectStore.ts`. Está fuera de tu lista **y fuera de la de
  todos**: pará y avisá antes de tocarlo.
- El cartel de `missingIds` no se puede redactar sin decir el motivo (por ejemplo, porque el diseño
  necesita explicar la acción). Pará: es D4 y no se resuelve en el código.

**Anotalo en §10 del plan y seguí:**

- Encontrás otra pantalla que se rompa con un 404 de proyecto. Anotala con el path: puede que el
  inventario de 3 archivos haya quedado corto.
- Te parece que el mensaje de error merece su propio componente en `components/ui/`. Anotalo, no lo
  agregues: `ui/` es del plan anterior y no es de nadie en este módulo.
- Necesitás modificar un archivo ajeno → **nunca**; anotalo.
