# T01 — Fundación: dependencias, tokens, tipografía y las 10 primitivas

- **Depende de:** nada
- **Bloquea:** T02, T03, T04, T05, T06, T07, T08, T09, T10, T11, T12 — o sea todas. Declarás los
  tipos que las demás importan.
- **Se puede correr en paralelo con:** **corre sola. No paralelizar con nada.**
- **Repo:** `/Users/lucho/Desktop/funnel/videogeneradorxd`
- **Archivos que este task puede tocar:** `package.json`, `tailwind.config.ts`,
  `src/app/globals.css`, `src/app/layout.tsx`, `src/lib/cn.ts`, `src/lib/ui-tokens.ts`,
  `src/components/ui/**`. Nada más.

Leé `00-PLAN-REDISENO-UI.md` completo. Tus contratos son **§4 (tokens), §5 (primitivas) y §6
(estados)**: los tres los declarás vos y nadie más los modifica. Copialos tal cual, no los mejores:
hay 11 tasks que se escriben contra ellos al mismo tiempo.

**Si esta task falla, se para el proyecto.** Todo lo demás importa de acá.

---

## 1. Objetivo

Cuando termines:

- `npm ls` muestra las dependencias nuevas instaladas y `package.json` las tiene con versión fija.
- `tailwind.config.ts` tiene los tokens de §4 **y todavía tiene `ink`, `panel` y `accent` como alias**.
- La app entera sigue renderizando aunque ninguna pantalla esté migrada.
- Geist y Geist Mono cargan vía `next/font`, sin flash de fuente.
- `src/components/ui/` tiene las 10 primitivas, compiladas y con sus tipos exportados.
- `node tasks/_verificacion-contraste.mjs` sigue en `FALLOS: 0`.

**Esta task no rediseña ninguna pantalla, no toca ningún componente de `src/components/` que no esté
en `ui/`, y no modifica una sola línea de `src/lib/` que no sea `cn.ts` o `ui-tokens.ts`.**

---

## 2. Dependencias — las declarás vos, todas de una vez

Instalá con versión **exacta** (sin `^`), incluidas las que van a usar tasks posteriores. Que dos
agentes editen `package.json` es la colisión más caras de todas, así que se hace una sola vez acá.

```bash
npm install --save-exact \
  class-variance-authority@0.7.1 \
  clsx@2.1.1 \
  tailwind-merge@2.6.1 \
  geist@1.7.2 \
  @phosphor-icons/react@2.1.10 \
  @radix-ui/react-select@2.3.7 \
  @radix-ui/react-dialog@1.1.23 \
  @radix-ui/react-tabs@1.1.21 \
  @radix-ui/react-slot@1.3.3

npm install --save-exact --save-dev tailwindcss-animate@1.0.7
```

**`tailwind-merge` va en 2.6.1 y NO en 3.x.** La línea 3 está hecha para Tailwind v4 y este proyecto
tiene Tailwind 3.4.19. Con la 3.x el merge de clases no reconoce los grupos de utilidades de v3 y
empieza a dejar pasar clases que deberían pisarse: el bug se ve como "le puse `bg-surface` y quedó el
color anterior", intermitente y difícil de rastrear.

**No corras `npx shadcn init`.** Está verificado que rompe esta app: ver D1 del plan. La versión 4
se cuelga y la 2.1.8 convierte `accent` en `hsl(var(--accent))` con la variable en `oklch()`, que es
CSS inválido, y deja los 25 usos de `bg-accent` sin fondo.

---

## 3. `src/lib/cn.ts`

Un solo export. Es el helper que todas las primitivas usan para combinar clases.

```ts
/** Combina clases y resuelve conflictos de Tailwind (la ultima gana). */
export function cn(...inputs: ClassValue[]): string;
```

Implementación: `twMerge(clsx(inputs))`. No le agregues nada más.

---

## 4. `tailwind.config.ts` — los tokens de §4, MÁS los alias viejos

Antes de escribir, **leé el archivo actual completo**. Tiene `ink`, `panel` y `accent` en
`theme.extend.colors` y `content` apuntando a `src/app` y `src/components`. El `content` se conserva
tal cual.

Agregá los tokens de §4 del plan. Y esto es lo que **no** podés omitir:

```ts
// ─── ALIAS DE TRANSICION — los borra T12, no vos ───────────────────────────
// Mientras las 8 pantallas se migran de a una, las que todavia no se tocaron siguen
// usando `bg-panel`, `bg-ink` y `bg-accent`. Si estos tres desaparecen ahora, la app
// ENTERA queda sin estilos hasta que termine la ultima task, y es una app en
// produccion que se usa mientras esto se hace.
//
// `accent` apunta al ambar nuevo a proposito: las pantallas sin migrar mejoran gratis
// y de paso se ve temprano si el acento nuevo funciona en contexto real.
ink: "#09090b",      // era #0b1020 (navy). Ahora apunta a bg.
panel: "#18181b",    // era #11182b. Ahora apunta a surface.
accent: "#fbbf24",   // era #6366f1 (indigo, que NO pasa WCAG AA). Ahora amber-400.
```

Agregá también `plugins: [require("tailwindcss-animate")]`, `darkMode` no hace falta (D12: tema único).

**El `accent` viejo era `#6366f1` y no pasaba AA** (4.45:1). Apuntarlo al ámbar es una mejora
inmediata, no un parche.

---

## 5. `src/app/globals.css`

**Leé el archivo actual.** Tiene tres cosas que se conservan: `color-scheme: dark`, la clase `.code`
(la usa `JsonEditor` y varios `<textarea>`) y las reglas de scrollbar. **No las borres**: `.code` está
referenciada por nombre en pantallas que todavía no se migraron.

Lo que agregás:

- Las variables CSS de los tokens, para que `ui-tokens.ts` pueda devolver nombres y no clases.
- `scroll-behavior: smooth` en `html`.
- `font-variant-numeric: tabular-nums` en una clase `.tnum`, que se aplica a todo dato numérico.
- El bloque de `prefers-reduced-motion` que apaga las animaciones (D11).

Reemplazá el `background-color: #0b1020` hardcodeado del `body` por el token.

---

## 6. `src/app/layout.tsx` — fuentes y nav

**Leé el archivo actual completo.** Tiene el header con la marca, el nav condicionado a `usuario`, y
el `SessionBar`. La estructura se conserva: **no cambies la lógica de `currentUser(cookies())` ni el
condicional del nav.** Eso es auth, no diseño.

Lo que cambiás:

1. Importá las fuentes de `geist/font/sans` y `geist/font/mono`, y aplicá sus `.variable` en el
   `<html>`. Con `next/font` no hay `<link>` ni flash.
2. El nav: **una sola línea, alto máximo 64px**, con el link activo marcado. Hoy no hay indicación de
   en qué pantalla estás. Usá `usePathname` en un componente cliente chico, o pasá el pathname desde
   el server. **No conviertas el layout entero en cliente:** lee la cookie en el server.
3. Agregá un link "saltar al contenido" oculto hasta el foco. Son dos usuarios que trabajan con
   teclado y hoy hay que tabular todo el nav en cada pantalla.
4. `<main>` con `max-w-[1400px] mx-auto`. Hoy es `max-w-6xl`, que en un monitor ancho desperdicia la
   mitad de la pantalla en una app que muestra grillas.

**El link de "Docs Vertex AI" que apunta afuera se mantiene**, con su `rel="noreferrer"`.

---

## 7. `src/lib/ui-tokens.ts` — el contrato de §6

Escribilo completo, con el mapeo de la tabla de §6 tal cual. La firma exacta está en el plan.

Lo importante: **devuelve tokens, no clases CSS.** `estadoDeJob("generating")` devuelve
`{ tone: "info", label: "Generando", animado: true }`. La traducción de `tone` a clases la hace
`Badge` y nadie más. Sin esta separación, cambiar el color de un estado obliga a abrir 8 pantallas.

Exportá también el tipo `Tone`, que las primitivas y las pantallas importan.

---

## 8. `src/components/ui/` — las 10 primitivas

Una por archivo, más un `index.ts` que las re-exporta. Las firmas están en §5 del plan y son
contrato: **respetalas exactamente**, hay 11 tasks escribiéndose contra ellas.

Notas por primitiva, solo donde la forma importa:

| Primitiva | Lo que no es obvio |
|---|---|
| `Button` | CVA para las 4 variantes × 2 tamaños. `loading` deshabilita y agrega spinner **sin cambiar el texto** (§5 regla 1): si el texto cambia, el botón cambia de ancho y salta el layout. `:active` con `translate-y-[1px]`. |
| `Input`/`Textarea` | Label arriba con `htmlFor`, error abajo con `role="alert"` y `aria-describedby`. El borde de error usa el token de peligro. |
| `Select` | Sobre `@radix-ui/react-select`, no el `<select>` nativo: el nativo no se puede estilar en el desplegable y la app tiene selectores de modelo con etiquetas largas y emoji. |
| `Badge` | Recibe `tone`, nunca color. Traduce `tone` a clases acá. El punto animado de `info` va con `motion-safe:animate-pulse` para que `prefers-reduced-motion` lo apague solo. |
| `Card` | Sin borde **y** sin sombra a la vez: solo `bg-surface` y padding. Una tarjeta con borde y sombra sobre fondo oscuro es el look genérico. |
| `Tabs` | Sobre `@radix-ui/react-tabs`. Reemplaza a `ProjectTabs`, que T02 va a reescribir encima de esto. |
| `Dialog` | Sobre `@radix-ui/react-dialog`, con foco atrapado y cierre con Escape, que sale gratis de Radix. |
| `Skeleton` | Bloques con la forma del contenido final, no un spinner. Hay pantallas que tardan segundos en el primer fetch. |
| `EmptyState` | Título, cuerpo, acción opcional. La app tiene varias listas que hoy quedan en blanco. |

**Ninguna primitiva hace `fetch` ni importa nada de `src/lib/` que no sea `cn` y `ui-tokens`.**

---

## 9. Tests

No hay framework de tests en el proyecto y **esta task no lo agrega** (sería una decisión de otro
dominio; si te parece necesario, va a §10). La verificación es la de abajo.

---

## 10. Verificación

Nada de esto es opcional. Una task que no corre su verificación no está terminada, y "compila" no es
verificación.

```bash
cd /Users/lucho/Desktop/funnel/videogeneradorxd

# 1 — las dependencias quedaron con version exacta, sin ^
node -e "const d={...require('./package.json').dependencies,...require('./package.json').devDependencies};for(const k of ['class-variance-authority','clsx','tailwind-merge','geist','@phosphor-icons/react','tailwindcss-animate'])console.log(k, d[k])"
# esperado exactamente: cada linea con la version pelada, sin ^ ni ~
#   tailwind-merge 2.6.1     <- si dice 3.x, esta MAL (ver §2)

# 2 — typecheck. El rm -rf .next NO es opcional
rm -rf .next && npx tsc --noEmit
# esperado: sin salida, exit 0

# 3 — build, y las 8 rutas siguen ahi
npm run build 2>&1 | grep -E "^[├└┌].*(login|imagenes|batch|pipeline|result|^./ )" 
# esperado: las rutas /, /login, /imagenes, /batch, /batch/review,
#           /batch/videos, /project/[id]/pipeline, /project/[id]/result

# 4 — los alias viejos SIGUEN existiendo (si no, la app sin migrar se rompe)
grep -E "^\s+(ink|panel|accent):" tailwind.config.ts
# esperado exactamente: las 3 lineas presentes

# 5 — contraste
node tasks/_verificacion-contraste.mjs
# esperado exactamente: FALLOS: 0

# 6 — no rompiste ningun endpoint
bash tasks/_verificacion-endpoints.sh
# esperado exactamente: SIN REGRESIONES

# 7 — las primitivas exportan lo que el contrato dice
node -e "const s=require('fs').readFileSync('src/components/ui/index.ts','utf8');for(const c of ['Button','Input','Textarea','Select','Badge','Card','Tabs','Dialog','Skeleton','EmptyState'])if(!s.includes(c))throw new Error('falta '+c);console.log('las 10 exportadas')"
# esperado exactamente: las 10 exportadas

# 8 — cero colores literales en las primitivas
grep -rE "#[0-9a-fA-F]{3,6}" src/components/ui/ src/lib/ui-tokens.ts || echo "sin colores literales"
# esperado exactamente: sin colores literales
```

Y a mano, en el browser, porque no se puede verificar con `curl`:

- La app **sin ninguna pantalla migrada** sigue viéndose bien. Entrá a `/`, `/batch` y `/imagenes`:
  tienen que seguir renderizando con los alias, ya con la fuente nueva y el acento ámbar.
- Tabulá desde el nav: el link "saltar al contenido" aparece al primer Tab, y el link activo se
  distingue.
- Con "reducir movimiento" activado en el sistema, el badge de `generating` no pulsa.

---

## 11. Cuándo parar

**Bloqueante, pará y avisá:**

- El build o el typecheck no pasan y no es algo de tu código (por ejemplo, `geist` no es compatible
  con Next 14.2.35). **Es lo que invalida el diseño entero:** las 11 tasks siguientes asumen que la
  fundación compila.
- `tailwind-merge` 2.6.1 tiene un conflicto de peer con algo instalado.
- Alguna primitiva no se puede implementar con la firma de §5 sin cambiarla. **No cambies la firma:**
  hay 11 tasks escritas contra ella. Pará y avisá.

**Anotalo en §10 del plan y seguí:**

- Encontrás que una pantalla usa `bg-panel` o `bg-ink` de una forma que el alias no cubre.
- Te parece que falta una primitiva (por ejemplo `Tooltip`). Anotala, no la agregues: si nadie la
  pidió, ninguna task la va a usar.
- Necesitás modificar un archivo ajeno → **nunca**; anotalo.
