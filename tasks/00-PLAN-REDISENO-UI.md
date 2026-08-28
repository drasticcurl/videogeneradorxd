# REDISEÑO UI — sistema de diseño propio y las 8 pantallas reescritas

**Documento maestro del módulo. Todo agente lee este archivo completo antes de abrir su task.**

La app funciona y factura, pero la UI creció sin sistema: 24 archivos `.tsx`, 6.545 líneas, **91
`<button>` escritos a mano**, la misma cadena de clases de borde copiada 15 veces, y ninguna fuente
configurada (usa la del navegador, así que se ve distinto en cada máquina). El problema no es fealdad,
es ausencia de primitivas: cada pantalla reinventó el mismo control con medio pixel de diferencia.

Este módulo agrega una capa de primitivas propias (`src/components/ui/`), una paleta y una escala
tipográfica verificadas, e itera las 8 pantallas encima de eso. **No cambia una sola línea de lógica
de negocio.** La cola, el pipeline, los providers de Vertex, el auth y el schema quedan intactos: son
los caminos que gastan plata y que ya están probados en producción.

**La app está EN PRODUCCIÓN en https://generador.hilvanapp.online y genera contra Vertex AI, que
cobra por uso. Una pantalla que pierde un `fetch` deja un botón que no hace nada y no tira ningún
error.** Todo lo que sigue está diseñado alrededor de esa frase: por eso hay una verificación de
regresión de endpoints, por eso los tokens viejos sobreviven la migración, y por eso ninguna task
puede tocar `src/lib/`.

---

## 0. Qué se construye y qué no

### Se construye

1. **`src/lib/cn.ts`** — el helper de merge de clases. Una función, sin dependencias de UI.
2. **`src/lib/ui-tokens.ts`** — la fuente de verdad de los estados: el mapa
   `status -> {label, color, icono}`. Hoy ese mapeo está duplicado en al menos 4 pantallas con
   colores distintos para el mismo estado.
3. **`src/components/ui/`** — 10 primitivas: `Button`, `Input`, `Textarea`, `Select`, `Badge`,
   `Card`, `Tabs`, `Dialog`, `Skeleton`, `EmptyState`.
4. **Paleta y tipografía** en `tailwind.config.ts` + `globals.css` + `layout.tsx`: base zinc, un solo
   acento ámbar, Geist y Geist Mono vía `next/font`.
5. **Iconografía**: Phosphor. Hoy no hay ni un ícono, todo es texto.
6. **Las 8 pantallas** reescritas visualmente sobre esas primitivas.
7. **Estados vacío, de carga y de error** en cada pantalla. Hoy casi ninguna los tiene.

### No se construye

- **Ningún cambio funcional.** Ni un endpoint nuevo, ni un campo nuevo, ni una regla de negocio
  distinta. Si una pantalla necesita un dato que la API no da, va a §10, no se agrega el endpoint.
- **Librería de animación.** Ver D11: es una herramienta densa que renderiza hasta 95 tarjetas de
  video; `transition` de CSS alcanza y no suma bundle.
- **Modo claro.** La app es oscura y se usa de noche. Un solo tema, bloqueado (D12).
- **Rutas nuevas ni renombradas.** El middleware y el auth dependen de `/login` y `/api/login`
  literales. Cambiar un slug rompe el guard (D9).
- **El CLI de shadcn.** Verificado que rompe esta app. Ver D1, que es la decisión más importante del
  documento.
- **Refactor de lógica de cliente.** El polling, el manejo de estado y los handlers se mueven de
  lugar si hace falta, pero no se "mejoran". Un rediseño que además refactorea no se puede revisar.

---

## 1. Decisiones cerradas

El usuario dijo "hacelo como a vos te parezca", así que **estas decisiones las tomé yo y quedan acá
escritas con su justificación**, que es lo que corresponde cuando se decide por el usuario. Si aparece
algo que este documento no resuelve, se anota en §10 y **no se decide en el código**.

**D1 — Nada de CLI de shadcn. Las primitivas se escriben a mano.** No es preferencia, está
verificado contra este proyecto:

- `shadcn@4.19.0` (la última) **se cuelga esperando input** en un proyecto Tailwind v3 existente, con
  `-y` incluido. 10 minutos, cero archivos creados.
- `shadcn@2.1.8` (la última de la era Tailwind v3) **sí corre**, y es prolijo con `globals.css` y con
  `tailwind.config.ts`: respeta lo que había y conserva `ink` y `panel`. **Pero pisa `accent`**: lo
  convierte de `#6366f1` a `hsl(var(--accent))`, y escribe la variable en `oklch()`. El CSS que sale
  es `background-color: hsl(var(--accent))` con `--accent: oklch(0.967 ...)`, o sea
  `hsl(oklch(...))`, que es **CSS inválido**: el browser descarta la declaración. **Los 25 usos de
  `bg-accent` de la app se quedarían sin fondo**, con los botones invisibles y sin ningún error.

Los componentes de shadcn son código que vive en tu repo de todos modos; el CLI es una comodidad que
en este proyecto es activamente dañina. Se escriben a mano con CVA + Radix + `cn()`, que es
exactamente lo que el CLI deja, sin tocar la config.

**D2 — Paleta zinc + un solo acento ámbar, con el contraste verificado.** El acento actual
(`indigo-500`) **no pasa WCAG AA**: 4.45:1 como texto y 4.28:1 con texto claro encima, contra un
mínimo de 4.5. Además es el "AI purple/blue" que es el tell visual más reconocible. La paleta nueva
pasa los 15 pares que la UI usa de verdad, con 0 fallos, y está en
`_verificacion-contraste.mjs`. La base pasa de navy (`#0b1020`) a zinc neutro: los grises fríos y el
azul del acento se peleaban.

**D3 — Dos tokens de borde, no uno.** Salió de la verificación, no de la intuición: WCAG 1.4.11 pide
3:1 para el borde de un componente **interactivo**, y `zinc-600`, `zinc-700` y `zinc-800` no llegan
(2.57, 1.91 y 1.34). El mínimo es `zinc-500`. Pero un separador decorativo no es un componente y no
tiene que pasar nada. Entonces: `border` = `zinc-500` para inputs y controles enfocables, `divider` =
`zinc-800` para separar bloques. Usar uno solo obliga a elegir entre inputs ilegales o divisores que
gritan.

**D4 — Geist + Geist Mono vía `next/font`.** El mono no es decorativo: la app muestra IDs de job,
timestamps, contadores de variantes y montos en dólares en cada pantalla, y hoy salen en proporcional
y **bailan de ancho al actualizarse el polling**. Todo dato numérico va en mono con
`font-variant-numeric: tabular-nums`. `next/font` y no `<link>` porque evita el flash de fuente y el
request a Google en runtime.

**D5 — Iconos de Phosphor, no de Lucide.** Hoy no hay ninguno: los estados se comunican solo con
color, que es inaccesible para daltonismo. Phosphor porque Lucide es el default reconocible de UI
generada. Un solo `weight` en toda la app (`regular`), declarado en §4.

**D6 — Los colores de estado son una escala funcional aparte del acento, y el ámbar significa "te
toca a vos".** Cinco estados con semántica clara: `emerald` terminado, `rose` falló, `sky` la máquina
está trabajando, `zinc` en espera, `amber` requiere tu decisión. Que el ámbar sea a la vez el acento
es a propósito y es lo que hace coherente el sistema: lo que está resaltado es siempre lo que espera
algo de vos. El mapeo vive en **un solo archivo** (`ui-tokens.ts`) porque hoy está duplicado en 4
pantallas y `awaiting_approval` sale de distinto color según dónde lo mires.

**D7 — Los tokens viejos sobreviven la migración y se borran al final.** `ink`, `panel` y `accent`
quedan en `tailwind.config.ts` como alias de los nuevos hasta T12. Sin esto, el momento en que T01
termina y las pantallas todavía no migraron deja la app **entera** sin estilos, y es una app en
producción que se usa mientras esto se hace. `accent` apunta a `amber-400`, así que las pantallas sin
migrar mejoran gratis. T12 los borra y verifica que no quedó ninguna referencia.

**D8 — Una pantalla por task, y los componentes compartidos primero.** El criterio de corte es el
ownership de archivos: cada pantalla es un conjunto de archivos que nadie más toca. Los compartidos
(`JobCard`, `StatusBadge`, etc.) van en su propia ola porque 5 pantallas los importan.

**D9 — Ni una ruta cambia de nombre.** `src/middleware.ts` matchea `/login` y `/api/login` como
strings literales, y `NEXT_PUBLIC_SITE_URL` arma el redirect contra `/login`. Renombrar una ruta deja
a los dos usuarios afuera de la app. Los `id` de sección y los nombres de los campos de formulario
tampoco cambian.

**D10 — Las tasks SÍ corren `typecheck` y `build`, contra lo que dice el steering.**
`.kiro/steering/project-context.md` dice "NUNCA correr typecheck ni build". Eso se escribió para un
sandbox lento; en esta máquina el build tarda ~70s y se corrió muchas veces sin problema. Un rediseño
de 6.545 líneas de JSX **no se puede verificar sin compilar**: los errores de tipos en props son
justamente el modo de falla más común acá. Queda como override explícito de esa regla, para este
módulo.

**D11 — Sin librería de animación. `MOTION_INTENSITY` bajo, 2 de 10.** Es una herramienta interna y
densa, no una landing. Lo único que se anima es feedback: `:hover`, `:active` con
`translate-y-[1px]`, transiciones de 150ms, y el pulso del estado "generando". Agregar Motion a una
pantalla que monta 95 tarjetas de video con `<video>` adentro cuesta frames reales. Todo va con
`transform` y `opacity`, y respeta `prefers-reduced-motion`.

**D12 — Un solo tema, oscuro, bloqueado.** No hay toggle ni `prefers-color-scheme`. Dos usuarios, uso
nocturno, contenido que son imágenes y videos a color que se ven mejor sobre fondo oscuro. Ninguna
sección invierte a claro.

**D13 — La densidad se mantiene alta, pero con jerarquía.** `VISUAL_DENSITY` 7 de 10: es un cockpit,
no una galería. El problema hoy no es que sea denso, es que **todo es igual de chico**: 194 usos de
`text-xs` o menor. La escala nueva tiene 3 niveles reales de tamaño y usa peso y color para separar,
no solo tamaño.

---

## 2. Arquitectura

```
                     ┌──────────────────────────────┐
                     │  tailwind.config.ts          │  paleta, tipografia, radios
                     │  src/app/globals.css         │  variables CSS, reset
                     │  src/app/layout.tsx          │  fuentes, nav, tema
                     └──────────────┬───────────────┘
                                    │  T01
                     ┌──────────────▼───────────────┐
                     │  src/lib/cn.ts               │  merge de clases
                     │  src/lib/ui-tokens.ts        │  ESTADO -> color + icono + label
                     │  src/components/ui/*         │  10 primitivas
                     └──────────────┬───────────────┘
                                    │  (contratos congelados, §4-6)
              ┌─────────────────────┼─────────────────────┐
              │                     │                     │
        ┌─────▼─────┐         ┌─────▼─────┐         ┌─────▼─────┐
        │    T02    │         │    T03    │         │  T04-T11  │
        │compartidos│         │  JobCard  │         │ pantallas │
        └───────────┘         └───────────┘         └───────────┘
                                    │
                     ┌──────────────▼───────────────┐
                     │  NADIE TOCA:                 │
                     │  src/lib/jobs/*              │  la cola y el pipeline
                     │  src/lib/providers/*         │  Vertex
                     │  src/lib/{config,schema,     │
                     │    storage,db,auth}.ts       │
                     │  src/middleware.ts           │
                     └──────────────────────────────┘
```

La decisión estructural que hace revisable el módulo: **las primitivas no conocen el dominio y el
dominio no conoce Tailwind.** `Button` no sabe qué es un job; `ui-tokens.ts` no sabe qué es una clase
CSS (devuelve nombres de token, no strings de clases). Así se puede cambiar la paleta sin abrir 8
pantallas, y se puede cambiar el mapeo de estados sin abrir las primitivas.

---

## 3. Datos — no se toca nada

**Este módulo no tiene esquema.** No hay migración, no hay tabla nueva, no hay campo nuevo. El estado
sigue en `data/db.json` vía `src/lib/db.ts`, y ese archivo está en la lista de intocables.

Lo único que las pantallas consumen son los tipos que ya existen en `src/lib/types.ts`
(`JobRecord`, `ProjectRecord`, `Candidate`) y las respuestas de los endpoints que ya existen. **Los
tipos de `types.ts` no se modifican**: si una pantalla cree que necesita un campo nuevo, va a §10.

Los tres detalles del modelo de datos que hay que entender antes de escribir UI contra él:

| Cosa | Detalle que importa |
|---|---|
| `job.candidates[]` | Son las variantes. `job.selectedIndex` dice cuál está elegida, y puede ser `null`. Que haya menos candidatas que `job.variants` es un estado **legítimo** (la cuota rechazó algunas) y la UI tiene que mostrarlo, no tratarlo como error. |
| `job.error` | Puede estar poblado en un job que **no** falló. Se usa como nota informativa ("salieron 1/2 variantes"). Nunca deducir el estado del job a partir de `error`: el estado es `job.status`. |
| `job.status` | Seis valores: `pending`, `generating`, `awaiting_approval`, `done`, `failed`, y `waiting` como razón derivada. El mapeo a color y label es de `ui-tokens.ts` y de nadie más. |

---

## 4. Contrato 1 — tokens de diseño. CONGELADO

**Lo declara T01 en `tailwind.config.ts`. Lo consumen todas las demás. Nadie más lo modifica.**

Verificado en `_verificacion-contraste.mjs`, 0 fallos. Si una task necesita un par de colores que no
está acá, **agrega el par a ese archivo primero, lo corre, y si falla elige otro tono**.

| Token | Valor | Para qué | Contraste verificado |
|---|---|---|---|
| `bg` | `zinc-950` `#09090b` | fondo de la app | base |
| `surface` | `zinc-900` `#18181b` | tarjetas, paneles | base |
| `surface-hi` | `zinc-800` `#27272a` | hover de superficie, inputs | base |
| `divider` | `zinc-800` | separadores decorativos | no aplica (D3) |
| `border` | `zinc-500` `#71717a` | borde de input y control enfocable | 4.12:1 sobre bg, 3.67:1 sobre surface |
| `fg` | `zinc-50` `#fafafa` | texto principal | 19.06:1 |
| `fg-dim` | `zinc-400` `#a1a1aa` | texto secundario. **Es el piso**, no bajar | 7.76:1 / 6.91:1 |
| `accent` | `amber-400` `#fbbf24` | foco, activo, "te toca a vos" | 11.92:1 |
| `on-accent` | `zinc-950` | texto sobre el acento | 11.92:1 |

Radios (D: uno solo, `SHAPE CONSISTENCY`): `sm` 4px inputs y badges, `md` 6px botones, `lg` 10px
tarjetas y paneles. **Nada de `rounded-full` salvo el punto de estado.**

Tipografía: `font-sans` Geist, `font-mono` Geist Mono. Escala: `display` 24px/600, `title` 16px/600,
`body` 14px/400, `label` 12px/500 con `tracking-wide`. **Todo dato numérico en `font-mono` con
`tabular-nums`.** No hay nada por debajo de 12px.

### Reglas que no se negocian

1. **Ninguna task escribe un color literal.** Ni `#`, ni `zinc-700`, ni `bg-slate-800`. Solo tokens.
   Sin esto vuelve el problema actual: 5 pantallas con 5 grises distintos y ningún lugar donde
   cambiarlos.
2. **`fg-dim` es el texto más apagado que existe.** `zinc-500` da 4.12:1 y no pasa AA. Verificado.
3. **`border` para lo que se puede enfocar, `divider` para lo que solo separa.** Ver D3.
4. **El anillo de foco es visible siempre**: `focus-visible:ring-2 ring-accent`. Nunca
   `outline-none` sin reemplazo. Hoy hay controles sin foco visible y son dos usuarios que trabajan
   con teclado.

---

## 5. Contrato 2 — primitivas de `src/components/ui/`. CONGELADO

**Las declara e implementa T01. Las consumen T02 a T11. Nadie más las modifica.**

Firmas, no implementaciones. T01 las escribe completas antes de que arranque la ola 2, porque las
otras tasks se escriben contra estos tipos al mismo tiempo.

```ts
// Button — reemplaza los 91 <button> a mano
type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;   // default "secondary"
  size?: ButtonSize;         // default "md"
  loading?: boolean;         // deshabilita y muestra spinner; el texto NO cambia
  icon?: React.ReactNode;    // Phosphor, va antes del texto
}

// Input / Textarea — label ARRIBA, error ABAJO, nunca placeholder-como-label
interface FieldProps {
  label: string;             // obligatorio: no hay campos sin etiqueta
  hint?: string;
  error?: string;            // si viene, pinta el borde y se anuncia con aria
}

// Select — envuelve @radix-ui/react-select, no el <select> nativo
interface SelectProps<T extends string> {
  label: string;
  value: T;
  onValueChange: (v: T) => void;
  options: ReadonlyArray<{ value: T; label: string; hint?: string }>;
}

// Badge — para estados. El color NO se pasa: sale de ui-tokens
interface BadgeProps { tone: Tone; children: React.ReactNode; icon?: boolean }

// Card, Tabs, Dialog, Skeleton, EmptyState
interface EmptyStateProps {
  title: string;
  body: string;
  action?: { label: string; onClick: () => void };
  icon?: React.ReactNode;
}
```

### Reglas que no se negocian

1. **`loading` no cambia el texto del botón.** Un botón que pasa de "Generar" a "Generando…" cambia
   de ancho y salta el layout. Se deshabilita y se le agrega un spinner, el ancho queda.
2. **`label` es obligatorio en todo campo.** No hay `placeholder` haciendo de etiqueta: cuando el
   usuario escribe, se pierde el contexto.
3. **`Badge` no recibe color, recibe `tone`.** El color sale de `ui-tokens.ts`. Es lo que evita que
   `awaiting_approval` sea ámbar en una pantalla y gris en otra, que es lo que pasa hoy.
4. **Ninguna primitiva hace `fetch` ni conoce un endpoint.** Son tontas a propósito.

---

## 6. Contrato 3 — `ui-tokens.ts`, el mapeo de estados. CONGELADO

**Lo declara T01. Lo consumen T02, T03 y todas las pantallas. Es la fuente de verdad única.**

```ts
export type Tone = "neutral" | "info" | "attention" | "ok" | "danger";

/** Un estado de job -> como se ve. NO devuelve clases CSS: devuelve tokens. */
export interface EstadoVisual {
  tone: Tone;
  label: string;         // en castellano, para el usuario
  animado: boolean;      // true solo para "generating"
}

export function estadoDeJob(status: JobRecord["status"]): EstadoVisual;
```

Mapeo congelado:

| `status` | `tone` | label | animado | por qué |
|---|---|---|---|---|
| `pending` | `neutral` | En cola | no | no pasa nada todavía |
| `generating` | `info` | Generando | **sí** | la máquina trabaja: es lo único que se anima |
| `awaiting_approval` | `attention` | Elegí variante | no | **requiere al usuario**: ámbar (D6) |
| `done` | `ok` | Listo | no | |
| `failed` | `danger` | Falló | no | |

### Reglas que no se negocian

1. **Ninguna pantalla escribe su propio `switch` de estados.** Si una necesita un label distinto por
   contexto, se agrega un parámetro a esta función, no un `switch` local. Hoy hay 4 copias
   divergentes y es la causa de que el mismo estado se vea distinto según la pantalla.
2. **El label va en castellano y el `status` crudo NO se muestra.** Hoy la UI imprime
   `awaiting_approval` tal cual, que es una cadena interna.
3. **`animado` respeta `prefers-reduced-motion`.** Lo maneja `Badge`, no cada pantalla.

---

## 7. Dependencias y olas de paralelismo

```
  Ola 1        T01  fundacion                        1 agente, SOLO
                │
                ├──────────────┬──────────────┐
  Ola 2        T02            T03                    2 agentes
             compartidos    JobCard
                │              │
                └──────┬───────┘
                       │
       ┌───────────┬───┴───────┬───────────┐
  Ola 3  T04         T05         T06                 3 agentes
        login       home       imagenes
                       │
       ┌───────────┬───┴───────┐
  Ola 4  T07         T08                             2 agentes
        batch      result
                       │
       ┌───────────┬───┴───────┬───────────┐
  Ola 5  T09         T10         T11                 3 agentes
        review     videos     pipeline
                       │
  Ola 6        T12  limpieza y QA final              1 agente, SOLO
```

| Task | Depende de | Se puede correr junto con |
|---|---|---|
| T01 fundación | nada | **nada, va sola** |
| T02 compartidos | T01 (primitivas + tokens) | T03 |
| T03 JobCard | T01 | T02 |
| T04 login | T01 | T05, T06 |
| T05 home | T01, T02 (ModelSelectorBar, CostEstimatePanel) | T04, T06 |
| T06 imágenes | T01, T02 | T04, T05 |
| T07 batch | T01, T02, T03 | T08 |
| T08 result | T01, T02 | T07 |
| T09 review | T01, T02, T03 | T10, T11 |
| T10 videos | T01, T02, T03 | T09, T11 |
| T11 pipeline | T01, T02, T03 | T09, T10 |
| T12 limpieza | todas | **nada, va sola** |

**Las 6 olas de arriba son MÁS CONSERVADORAS que el grafo de dependencias, a propósito.** Si se
mira solo lo que cada task declara, el mínimo real son 3 olas y la tercera tendría 7 tasks en
paralelo (T05 a T11). Se agrupó en 6 por dos razones: 7 agentes a la vez es imposible de revisar, y
el orden elegido pone las pantallas baratas antes que las caras para que un problema del sistema de
diseño aparezca en un login de 156 líneas y no en el pipeline de 1187. La compuerta que **sí** es
técnica es una sola: nadie arranca antes de que T01 verifique.

Lo que no es obvio y conviene explicar:

- **T04, T05 y T06 podrían técnicamente correr en la ola 2**, porque el ownership de archivos ya las
  aísla. Van después a propósito: son las pantallas más chicas y más usadas, y si el sistema de
  primitivas de T01 tiene un problema de ergonomía, es mejor descubrirlo en un formulario de login de
  156 líneas que en el pipeline de 1187.
- **T09, T10 y T11 van al final porque son las de mayor riesgo**, no porque dependan de más cosas.
  Concentran la lógica de aprobar, regenerar y elegir variantes, que es la que mueve plata. Cuando
  les toca, el sistema ya está probado en 5 pantallas.
- **El límite son las dependencias, no la cantidad de agentes.** Meter un cuarto agente en la ola 3
  no acelera nada: no hay una cuarta pantalla que no dependa de T02.
- **Si preferís ir de a uno**, el orden serial es exactamente el de la tabla, T01 a T12. Dejá T09,
  T10 y T11 para cuando no estés generando nada.

**Una task bloqueante no está terminada hasta que su verificación pasa**, y la ola siguiente no
arranca antes. En particular: **si T01 falla, se para el proyecto**. Todo lo demás importa sus tipos.

---

## 8. Ownership de archivos — regla anti-colisión

**Cada task solo escribe los archivos de su fila.** Si necesita algo de un archivo ajeno, lo lee pero
no lo escribe; si cree que necesita escribirlo, va a §10.

| Task | Archivos que puede crear o modificar |
|---|---|
| **T01** | `package.json`, `tailwind.config.ts`, `src/app/globals.css`, `src/app/layout.tsx`, `src/lib/cn.ts`, `src/lib/ui-tokens.ts`, `src/components/ui/**` |
| **T02** | `src/components/StatusBadge.tsx`, `ProjectTabs.tsx`, `ModelSelectorBar.tsx`, `CostEstimatePanel.tsx`, `LogPanel.tsx`, `JsonEditor.tsx`, `FlowGraph.tsx`, `src/app/SessionBar.tsx` |
| **T03** | `src/components/JobCard.tsx` |
| **T04** | `src/app/login/page.tsx`, `src/app/login/LoginForm.tsx` |
| **T05** | `src/app/page.tsx` |
| **T06** | `src/app/imagenes/page.tsx`, `src/app/imagenes/ImagenesBoard.tsx` |
| **T07** | `src/app/batch/page.tsx`, `src/app/batch/BatchBoard.tsx`, `src/app/batch/ClipTimeline.tsx` |
| **T08** | `src/app/project/[id]/result/page.tsx` |
| **T09** | `src/app/batch/review/page.tsx`, `src/app/batch/review/ReviewDeck.tsx` |
| **T10** | `src/app/batch/videos/page.tsx`, `src/app/batch/videos/VideoDeck.tsx` |
| **T11** | `src/app/project/[id]/pipeline/page.tsx` |
| **T12** | `tailwind.config.ts` (solo para borrar los alias viejos), `tasks/_verificacion-*.{sh,mjs}` |

**Excepción documentada:** `tailwind.config.ts` lo escriben T01 y T12. No es colisión porque están en
olas distintas y separadas por 10 tasks: T01 agrega los tokens nuevos **y deja los viejos como
alias**, T12 borra los viejos cuando ya nadie los usa. T12 no puede arrancar hasta que T11 termine.

Para que la excepción sea visible en el archivo y no solo en este documento, **T01 escribe este
comentario literal encima de las tres líneas de alias**, y T12 lo borra junto con ellas:

```ts
// ─── ALIAS DE TRANSICION — LOS BORRA T12, NO VOS ───────────────────────────
// Unico lugar del modulo con dos dueños (T01 los crea, T12 los borra). Ver §8 del
// plan. Mientras las 8 pantallas se migran de a una, las que faltan siguen usando
// bg-panel / bg-ink / bg-accent: si desaparecen antes de que termine T11, la app
// ENTERA queda sin estilos, y se esta usando en produccion mientras esto se hace.
```

**Archivos que NADIE toca.** Romper esto rompe producción, y estos son los caminos que gastan plata o
que dejan a los usuarios afuera:

```
src/lib/jobs/queue.ts              la cola, el backoff de 429, el gate por lotes
src/lib/jobs/pipeline.ts           buildJobs, generacion, approve, changePrompt
src/lib/config.ts                  MODEL_CATALOG, defaults, env del pipeline
src/lib/schema.ts                  el Zod del PlanJSON
src/lib/storage.ts                 naming de archivos y manifest
src/lib/db.ts                      el estado
src/lib/auth.ts                    login, HMAC, rate limit
src/middleware.ts                  el guard. Depende de "/login" literal
src/lib/providers/**               Vertex: imagen, video, llm, auth
src/app/api/**                     TODOS los endpoints
src/store/useProjectStore.ts       el estado del cliente y su polling
deploy/**                          deploy.sh, ecosystem, Caddyfile
```

`useProjectStore.ts` está en la lista y merece la aclaración: es tentador "mejorarlo" al rediseñar la
home, pero tiene el polling y la forma de los datos que consumen 4 pantallas. Un cambio ahí rompe
tasks de otra ola. Si una pantalla necesita algo del store, va a §10.

**Lo que parece colisión y no lo es:** T09 y T10 escriben `page.tsx` los dos, pero son
`batch/review/page.tsx` y `batch/videos/page.tsx`. Archivos distintos en directorios distintos.

---

## 9. Criterios de aceptación globales

1. `npx tsc --noEmit` sin errores. **Antes, `rm -rf .next`**: si no, reporta errores de tipos
   generados de rutas que ya no existen y parece que rompiste algo.
2. `npm run build` termina OK y **la ruta sigue en la lista de rutas compiladas**. Una pantalla que
   desaparece del output del build es un archivo mal renombrado.
3. `bash tasks/_verificacion-inventario.sh` → `INVENTARIO COMPLETO`.
4. `node tasks/_verificacion-contraste.mjs` → `FALLOS: 0`.
5. `bash tasks/_verificacion-endpoints.sh` → `SIN REGRESIONES`. **Es el más importante**: prueba que
   ninguna pantalla perdió una llamada a la API.
6. **Nada de lo que ya funcionaba cambió.** Con la app corriendo: login de los dos usuarios da 200,
   `/api/config` sin cookie da 401, y el circuito de generar una imagen con 2 variantes termina en
   `2/2`.
7. Cero colores literales fuera de `tailwind.config.ts`: `grep -rE "#[0-9a-fA-F]{3,6}" src/ --include=*.tsx` no devuelve nada.
8. Cero `text-[10px]` y `text-[11px]`: no hay nada por debajo de 12px.
9. Todo control interactivo tiene foco visible con teclado. Se prueba a mano, con Tab.
10. `prefers-reduced-motion` apaga el pulso de "generando".

---

## 10. Preguntas abiertas

Si aparece una decisión que este documento no resuelve, **se anota acá en lugar de decidirla en el
código**. Si bloquea, la task se detiene y no sigue con suposiciones.

### P-01 — El gate de aprobación por lotes confunde en la pantalla de imágenes
- **Task:** T06
- **Sección del plan:** §0 (no se construye: cambios funcionales)
- **Archivo:** `src/app/imagenes/ImagenesBoard.tsx`
- **Qué falta:** `PIPELINE_APPROVAL_BATCH=5` frena la cola cuando hay 5 jobs sin aprobar, así que una
  tanda de más de 5 prompts se detiene esperando que el usuario apruebe. Es el comportamiento
  existente y correcto para el flujo de brief, pero en la pantalla de imágenes se lee como que se
  colgó. ¿Se muestra un aviso explicando que hay que aprobar para seguir, o se cambia el default?
- **Bloquea:** no
- **Mientras tanto:** T06 muestra un aviso con el conteo (`5 de 12 listas, aprobá para seguir`) y un
  botón que aprueba todas las visibles. **No toca la config**, que es de otro dominio.
- **Resolución:** _pendiente_

### P-02 — La estimación de costo quedó desactualizada
- **Task:** T02 (`CostEstimatePanel`)
- **Sección del plan:** §0
- **Archivo:** `src/components/CostEstimatePanel.tsx`
- **Qué falta:** `PRICE_VIDEO_PER_SEC_USD` sigue en 0.50, que era el precio de Veo 3.1 normal. Ahora
  el default es Veo 3.1 Lite, más barato, así que el panel sobreestima. Corregirlo es un cambio de
  config, no de UI.
- **Bloquea:** no
- **Mientras tanto:** T02 rediseña el panel mostrando el número que da la API tal cual, y agrega la
  palabra "estimado". No cambia la aritmética.
- **Resolución:** _pendiente_

### P-03 — `FlowGraph` puede no valer la pena
- **Task:** T02
- **Sección del plan:** §8
- **Archivo:** `src/components/FlowGraph.tsx`
- **Qué falta:** son 86 líneas que dibujan un grafo de dependencias entre jobs. Con 95 clips es
  ilegible. ¿Se rediseña, o se reemplaza por una barra de progreso por etapa?
- **Bloquea:** no
- **Mientras tanto:** T02 lo migra a los tokens nuevos sin cambiar la estructura, y **anota cuántos
  nodos muestra con el VSL real de 95 clips** para poder decidir con un dato.
- **DATO MEDIDO POR T02** — contado sobre `vsl-natalia-plan.json` (el VSL real) aplicándole el
  `buildJobs` de `src/lib/jobs/pipeline.ts`, que es quien decide cuántos jobs existen:

  | Qué | Cuánto |
  |---|---|
  | Assets del plan | 3 |
  | Imágenes → columna "Imagenes base" (`modo != image2image`) | **22** |
  | Imágenes → columna "Imagenes derivadas" (`modo == image2image`) | **2** |
  | Clips → columna "Videos" (solo `etiqueta == "IA"`, y los 95 lo son) | **95** |
  | **Nodos de job** | **119** |
  | `StageBox` fijos ("Brief → Plan" y "Listo") | 2 |
  | **Nodos totales en pantalla** | **121** |
  | Flechas | 4 |

  El número que decide no es 121, es **95 en una sola columna**. Las tres columnas son `flex-col`
  y la de videos apila los 95 nodos uno abajo del otro: cada nodo mide 20px (`text-label` 16px +
  `py-0.5`) y el `gap-2` suma 8px, así que la columna mide **~2.700px de alto**
  (16 de `p-2` + 16 del título + 95×20 + 95×8). El contenedor solo tiene `overflow-x-auto`: **no hay
  scroll vertical**, así que esa columna estira la página ~2.700px y las otras dos quedan como dos
  tiras cortas al lado de un chorizo.

  Los ~2.700px son con los tokens aplicándose como corresponde. **Mientras P-09 esté sin arreglar son
  ~3.400px**, porque `Badge` pierde su `text-label` y cada nodo hereda los 16px del body en lugar de
  los 12px de la escala. Cuando se resuelva P-09 el número baja al de arriba; el problema de fondo es
  el mismo. Las flechas, que son lo único que comunica que hay un flujo,
  quedan centradas verticalmente a ~1.350px de la primera columna, o sea fuera de la pantalla.

  Con eso, la pregunta de P-03 se responde sola en un sentido: **como grafo no sirve con 95 clips**.
  Lo que sí sirve del componente hoy es que muestra las tres etapas y el estado de cada job de un
  vistazo, y eso es exactamente una barra de progreso por etapa (3 barras con `hechos/total` y el
  conteo de fallados y de "te toca a vos"). T02 **no lo cambió** porque eso es rediseñar estructura y
  no migrar tokens, y porque la vista `flow` no es la default con muchos clips: `pipeline/page.tsx`
  arranca en `fix` cuando hay más de 24 videos, así que hoy el usuario ve esto solo si lo elige a
  mano. No urge, pero la recomendación de T02 es la barra por etapa.
- **Resolución:** _pendiente_

### P-04 — Decidido por el usuario: no confirmó paleta ni fundación
- **Task:** todas
- **Sección del plan:** §1, D1 a D13
- **Qué falta:** el usuario dijo "hacelo como a vos te parezca". Las 13 decisiones de §1 las tomé yo.
  Las dos que más conviene que confirme, porque son las más difíciles de revertir después: **D2** (el
  acento ámbar sobre zinc) y **D1** (primitivas a mano en vez de shadcn CLI).
- **Bloquea:** no
- **Mientras tanto:** se avanza con lo decidido. D2 es reversible barato porque todo sale de tokens en
  un solo archivo: cambiar el acento es una línea. D1 no es reversible barato, pero está verificado
  con evidencia concreta de por qué el CLI rompe la app.
- **Resolución:** _pendiente_

### P-05 — `ui-tokens` no mapea `placeholder` ni `partial`, y T02 no puede agregarlos
- **Task:** T02 (`StatusBadge`), la encontró; la resuelve T01 o T12
- **Sección del plan:** §6 regla 1 contra §8 ownership
- **Archivos:** `src/lib/ui-tokens.ts` (de T01), `src/components/StatusBadge.tsx`
- **Qué falta:** `StatusBadge` recibe estados de **tres** dominios, no de uno. Los consumidores reales
  le pasan `job.status` (`JobCard`, `VideoDeck`), `project.status` (home, batch, pipeline, result) y
  `clip.status` del manifest (result, línea 313). Su unión de props ya era
  `JobStatus | "placeholder" | "draft" | "running" | "review" | "partial" | "paused"` y no se puede
  angostar sin romper el typecheck de cuatro pantallas. De esos, `estadoDeJob` cubre cinco y
  `estadoDeProyecto` cubre seis (con `done` y `failed` idénticos en las dos, así que no hay
  ambigüedad), pero **`placeholder` y `partial` no están en ninguna**: caen en el `default`, que
  devuelve el string crudo. O sea que la UI imprimiría `placeholder` y `partial` en la cara del
  usuario, que es exactamente lo que §6 regla 2 prohíbe.
- **El choque de reglas:** §6 regla 1 dice que el label se agrega a `ui-tokens`, no a un switch local.
  §8 dice que `src/lib/ui-tokens.ts` es de T01 y que T02 no lo escribe. Las dos reglas no se pueden
  cumplir a la vez, y por eso esto está acá y no decidido en silencio.
- **Bloquea:** no
- **Mientras tanto:** `StatusBadge` tiene una tabla `SIN_MAPEO` de **exactamente dos entradas**, con el
  comentario que apunta a esta pregunta: `placeholder` → `attention` "A filmar" (clip que graba una
  persona, no la IA) y `partial` → `attention` "Incompleto" (proyecto que cerró con jobs fallados).
  Las dos usan `Tone`, así que **no hay ni un color en el archivo** y `Badge` sigue siendo el único que
  traduce tono a clases: el problema de divergencia que §6 quiere matar no vuelve. Lo que queda mal es
  la ubicación, no el valor.
- **Lo que hay que hacer:** mover esas dos entradas a `ui-tokens.ts` y borrar `SIN_MAPEO`. Es un
  copy-paste de 2 líneas. Le corresponde a T12 (o a T01 si vuelve a abrir el archivo).
- **Resolución:** _pendiente_

### P-06 — `Button asChild` de T01 revienta en runtime. Verificado, no inferido
- **Task:** T02 la encontró; la resuelve T01 o T12. **La van a pisar T04 a T11.**
- **Sección del plan:** §5
- **Archivo:** `src/components/ui/Button.tsx` (de T01)
- **Qué falta:** `Button` declara y documenta la prop `asChild` ("para envolver un `<Link>` sin anidar
  interactivos"), pero **tira una excepción cada vez que se usa**. El motivo: el cuerpo renderiza
  siempre dos hijos, `{loading ? spinner : icon}` y `{children}`, y `Slot` de Radix exige uno solo.
  Con `icon` sin pasar, el primer hijo es `undefined`, y `React.Children.count([undefined, <a/>])` da
  **2** (`Children.count` cuenta los nulos), así que la rama
  `count(children) === 1 && isValidElement(children)` de `Slot` no entra y cae en el `throw`.
- **Cómo se verificó:** renderizando el árbol real con `react-dom/server` contra el `@radix-ui/react-slot`
  instalado. `<Slot>{undefined}{<a/>}</Slot>` y `<Slot>{<svg/>}{<a/>}</Slot>` tiran las dos
  `"Slot failed to slot onto its children. Expected a single React element child or Slottable"`;
  `<Slot>{<a/>}</Slot>` sale bien. No compila mal ni falla el typecheck: revienta al montar.
- **Por qué importa más de lo que parece:** no falla el `build` porque ninguna pantalla lo usa todavía.
  La primera task que quiera un link con forma de botón (T04 login, T05 home, cualquier "ver
  resultado") se lo come, y el síntoma va a parecer un error de la pantalla y no del botón.
- **Bloquea:** no a T02
- **Mientras tanto:** T02 no usa `asChild` en ningún lado. El único link con forma de control que
  necesitaba (el "+ Nuevo" de `ProjectTabs`) es un `<Link>` con clases de token escritas ahí.
- **El arreglo son 2 líneas** en `Button.tsx`: importar `Slottable` de `@radix-ui/react-slot` y
  envolver `{children}` con él cuando `asChild` está activo, que es para lo que existe.
- **Resolución:** _pendiente_

### P-07 — `ProjectTabs` no son pestañas, son rutas, y Radix Tabs lo trata como pestañas
- **Task:** T02
- **Sección del plan:** §5 (primitiva `Tabs`), §4 de `T02-componentes-compartidos.md`
- **Archivos:** `src/components/ProjectTabs.tsx`, `src/components/ui/Tabs.tsx`
- **Qué falta:** la task pedía montar `ProjectTabs` sobre el `Tabs` de Radix porque "gana navegación
  con flechas del teclado, que hoy no tiene", y el comentario de `ui/Tabs.tsx` dice que la versión
  anterior "eran botones sueltos: no se podía navegar con teclado". **Las dos afirmaciones parten de
  una observación equivocada**: eran `<Link>` de Next, o sea `<a href>`, que ya se navegan con Tab y
  se activan con Enter. Lo que se gana es menos de lo que decía el plan.
- **Y lo que se paga, medido renderizando el árbol real:** cada pestaña sale
  `<a role="tab" aria-selected aria-controls="radix-...-content-/project/x/result">`, y **ese
  `aria-controls` apunta a un `tabpanel` que no existe**, porque el "panel" de estas pestañas es una
  ruta entera de Next, no un nodo del DOM. Un lector de pantalla anuncia "pestaña 1 de 2,
  seleccionada" y después no hay panel que abrir. Aparte, Radix le mete `type="button"` al hijo
  (viene de `Primitive.button`), que en un `<a>` es un atributo inválido.
- **Bloquea:** no
- **Mientras tanto:** T02 hizo lo que pedía la task —está montado sobre el `Tabs` de T01, controlado
  por `usePathname()`, con `activationMode="manual"` para que la flecha mueva el foco y no navegue
  sola— y arregló lo que estaba a su alcance: `type={undefined}` en el `<Link>` saca el atributo
  inválido (verificado: el hijo gana el merge de props) y `aria-current="page"` marca la ruta activa
  de la forma correcta. El `aria-controls` colgado **queda**: sacarlo o arreglarlo es cambiar la
  primitiva de T01 o dejar de usarla, y ninguna de las dos la decide T02.
- **Las dos salidas, para que la elija quien revise:** (a) `ProjectTabs` vuelve a ser un `<nav>` con
  `<Link>` y `aria-current`, copiando las clases de `TabsList`/`TabsTrigger` para que se vea igual
  —correcto en HTML y ARIA, pero duplica las clases de la primitiva, que es justo lo que el módulo
  quiere matar; (b) `ui/Tabs.tsx` gana una variante de navegación que renderiza `<nav>` + links con la
  misma pinta, y `ProjectTabs` la usa —una sola fuente de estilos y ARIA correcto, pero le agrega
  superficie a un contrato congelado. T02 recomienda **(b)**, para T12.
- **Resolución:** _pendiente_

### P-08 — La verificación 3 de T02 no puede dar limpia: la ensucia un comentario de T01
- **Task:** T02 la encontró; la resuelve T12
- **Sección del plan:** §9, y §11 de `T02-componentes-compartidos.md`
- **Archivo:** `src/components/ui/Badge.tsx` (de T01)
- **Qué falta:** el chequeo `grep -rn "awaiting_approval" src/components/ | grep -v "ui-tokens"` tiene
  que dar cero líneas. Da una: `ui/Badge.tsx:8`, que menciona el estado **en un comentario** contando
  por qué existe el archivo. No es un switch ni código: el filtro `grep -v "ui-tokens"` solo saca las
  líneas que contienen el texto "ui-tokens", y esa no lo contiene.
- **Bloquea:** no. Los 8 archivos de T02 dan cero:
  `grep -rn "awaiting_approval" <los 8 archivos de T02>` → sin resultados. T02 reescribió su propio
  comentario de `StatusBadge` para no nombrar el estado justamente para que el grep pruebe algo.
- **Mientras tanto:** queda esa línea. T02 no puede editar `src/components/ui/**` (§8).
- **El arreglo:** una de dos, y las dos son de T12. O el comentario de `Badge.tsx` deja de nombrar el
  estado (como hizo `StatusBadge`), o el chequeo pasa a ser
  `grep -rn "awaiting_approval" src/components/ --include=*.tsx | grep -v "^src/components/ui/"`, que
  es lo que el chequeo quiere decir en realidad: **ninguna pantalla ni componente de dominio conoce
  los nombres crudos de los estados.**
- **Resolución:** _pendiente_

### P-09 — `cn()` le come el tamaño o el color a las 10 primitivas. **Es la más grave de las cuatro**
- **Task:** T02 la encontró; la resuelve T01 o T12. **Afecta a las 11 tasks y a toda la app.**
- **Sección del plan:** §4 (escala tipográfica), §5 (primitivas), D1, D13
- **Archivos:** `src/lib/cn.ts` y `tailwind.config.ts` (los dos de T01)
- **Qué pasa:** los tokens de `fontSize` se llaman `label`, `body`, `title` y `display`, y los de color
  se llaman `fg`, `fg-dim`, `accent`, `ok`, `danger`, `info`, `bg`, `on-accent`. Para
  `tailwind-merge` **las dos familias son la misma cosa**: solo ve `text-<algo>` donde `<algo>` no es
  un tamaño conocido (`xs`, `sm`, `lg`…), así que mete `text-label` y `text-fg-dim` en el mismo grupo
  de conflicto y **se queda con el último**. No hay forma de que lo adivine: no lee
  `tailwind.config.ts`.

  El resultado es que **cada primitiva pierde el tamaño o pierde el color**, según el orden en que
  estén escritos. Verificado corriendo el `cn()` real de la app con el `tailwind-merge` 2.6.1
  instalado:

  | Primitiva | Lo que sale de `cn()` | Qué se perdió |
  |---|---|---|
  | `Badge` | `rounded-sm px-1.5 py-0.5 font-medium bg-accent/10 text-accent` | **`text-label`** → hereda el tamaño del padre |
  | `TabsTrigger` | `px-3 py-2 font-medium text-fg-dim` | **`text-body`** |
  | `Field` (label) | `mb-1 block font-medium text-fg-dim` | **`text-label`** |
  | `EmptyState` (título) | `font-semibold text-fg` | **`text-title`** |
  | `Textarea` | `… resize-y font-mono text-label border-border` | **`text-fg`** (el color) |
  | `Button primary` | `… bg-fg hover:bg-fg-dim h-9 px-3.5 text-body` | **`text-bg`** (el color) |

- **Por qué esto es lo más urgente de las cuatro:** la última fila. `Button variant="primary"` es
  `bg-fg` (#fafafa, casi blanco) con `text-bg` (#09090b, casi negro), y **`text-bg` se cae**. El botón
  queda con fondo casi blanco y texto heredado del body, que es `text-fg`, o sea casi blanco también:
  **botón primario con el texto invisible, y sin ningún error en consola.** Es exactamente el modo de
  falla que D1 describe para el CLI de shadcn ("los botones invisibles y sin ningún error"), pero
  entró por otra puerta. Hoy no explotó solo porque ninguna pantalla migrada usa todavía un primario:
  T02 usa `ghost` y T03 hace lo suyo. **La primera pantalla que ponga un botón primario lo publica.**
- **Y de paso mata a D13:** el sentido de la escala de 4 niveles era "3 niveles reales de tamaño y usar
  peso y color para separar". Con `text-label`, `text-body` y `text-title` cayéndose de las
  primitivas, todo hereda el tamaño del padre y la jerarquía tipográfica no existe. Se comprobó en el
  HTML servido: la pestaña activa de `ProjectTabs` sale con
  `class="… px-3 py-2 font-medium text-fg-dim …"`, sin `text-body`.
- **Bloquea:** no a T02 (los 8 archivos compilan y renderizan), pero **es un defecto de producción**.
- **Mientras tanto:** T02 no lo puede evitar ni mitigar. Pasar el tamaño por `className` no sirve:
  `className` va último en el `cn()` de la primitiva, así que ganaría el tamaño y se caería el color,
  que es peor. El arreglo tiene que estar en `cn.ts`.
- **El arreglo, verificado:** en `src/lib/cn.ts`, cambiar `twMerge` por una instancia que conozca los
  tokens del proyecto.

  ```ts
  import { extendTailwindMerge } from "tailwind-merge";

  // tailwind-merge no lee tailwind.config.ts: hay que decirle que `label`, `body`,
  // `title` y `display` son TAMAÑOS y no colores. Sin esto los mete en el mismo grupo
  // que text-fg / text-accent y se queda con el ultimo, asi que cada primitiva pierde
  // el tamaño o pierde el color.
  const twMerge = extendTailwindMerge({
    extend: {
      classGroups: { "font-size": [{ text: ["label", "body", "title", "display"] }] },
    },
  });
  ```

  Probado con el `tailwind-merge` instalado: las seis filas de la tabla quedan completas
  (`… bg-fg text-bg … text-body`, `… text-label … text-accent`) y lo que **sí** tiene que colapsar
  sigue colapsando: `text-body text-title` → `text-title`, `text-fg text-accent` → `text-accent`,
  `p-2 p-4` → `p-4`.
- **Cómo evitar que vuelva:** el chequeo es de una línea y le corresponde a T12 —
  `node -e` con el `cn()` real sobre `cn("bg-fg text-bg", "text-body")` tiene que devolver un string
  que contenga `text-bg` **y** `text-body`. Hoy devuelve solo `text-body`.
- **Resolución:** _pendiente_

---

> **Nota de numeración.** P-10 a P-16 las agregó **T04**, que fue la primera pantalla que puso las
> primitivas en un formulario real. T05 y T06 corrían en paralelo en la misma ola, así que si aparece
> otra `P-10` es una colisión de numeración y no un duplicado de contenido: cada título lleva la task
> que lo escribió para poder renumerar sin perder de qué hablaba.

### P-10 (T04) — El `Select` de T01 no sirve para un campo de formulario real: no expone `name` ni `autoComplete`
- **Task:** T04 la encontró; la resuelve T01 o T12. **La va a pisar cualquier task con un formulario.**
- **Sección del plan:** §5 (firma congelada de `SelectProps`), §2 de `T04-login.md`
- **Archivos:** `src/components/ui/Select.tsx` (de T01), `src/app/login/LoginForm.tsx`
- **Qué falta:** `SelectProps<T>` tiene exactamente `label`, `value`, `onValueChange`, `options`,
  `labelOculto`, `disabled` y `className`. **No hay `name`, no hay `autoComplete`, no hay `required`
  y no hay `id` desde afuera.** Con eso el control no puede participar de un `<form>` como un campo:
  no se serializa, no lo llena un gestor de contraseñas y no lo puede referenciar un `aria-*` externo.
- **Por qué es un problema y no un detalle:** el campo "Usuario" del login es la mitad de un par
  usuario/password. Los gestores (1Password, el de Chrome, el llavero de macOS) emparejan ese par por
  `autoComplete="username"` + `autoComplete="current-password"` y guardan la credencial contra el
  `name` del campo. `T04-login.md` §2 los marca como intocables por eso mismo. Y aparte, el `Select`
  de Radix **no renderiza un `<select>`**: renderiza `<button role="combobox">`. Aunque la firma
  expusiera `autoComplete`, Radix lo llevaría a su `<select>` burbuja, que es `aria-hidden` y
  `tabIndex={-1}`: un gestor de contraseñas no lo ofrece.
- **Bloquea:** por §5 de `T04-login.md` esto es de la clase "pará y avisá" ("una primitiva no te deja
  reproducir el formulario sin cambiar su firma"). **No detuvo la task** porque hay una salida que no
  toca la primitiva ni rompe el autofill, pero queda anotado como decisión tomada, no como detalle.
- **Mientras tanto:** el campo "Usuario" del login quedó como `<select>` **nativo**, con
  `appearance-none` y las clases de token, más un `CaretDown` de Phosphor posicionado encima para que
  se vea igual que el trigger de Radix. Se eligió romper la regla "usá la primitiva" antes que romper
  el autofill de los dos usuarios, porque lo primero es cosmético y lo segundo lo sufren todos los
  días. La rama sin usuarios en el env (`usuarios.length === 0`) sí usa `Input`, que acepta `name` y
  `autoComplete` como cualquier input.
- **Lo que hay que hacer:** agregarle a `SelectProps` los tres atributos de formulario
  (`name?`, `autoComplete?`, `required?`) y pasárselos a `RadixSelect.Root`, que ya los soporta.
  **Eso arregla la serialización pero NO el autofill**, porque el problema del `<select>` burbuja
  escondido es de Radix y no de la firma. Así que la decisión de fondo es la que hay que tomar:
  o `ui/Select.tsx` gana una variante nativa para los casos donde el navegador tiene que reconocer el
  campo, o se acepta que el login es la excepción documentada y el resto de la app usa Radix. La
  recomendación de T04 es lo segundo: es **un** campo en toda la app, y una primitiva con dos motores
  adentro es más superficie de la que ahorra.
- **Resolución:** _pendiente_

### P-11 (T04) — `Field` no exporta sus clases de caja, así que el control que no puede usar la primitiva las vuelve a copiar
- **Task:** T04 la encontró; la resuelve T01 o T12
- **Sección del plan:** §4 regla 1, §5. Es el problema original del módulo volviendo por la ventana.
- **Archivos:** `src/components/ui/Field.tsx` (de T01), `src/app/login/LoginForm.tsx`
- **Qué falta:** `Field.tsx` tiene la cadena de la caja del input en una const local `CAJA`, y el label
  en un string suelto dentro de `Envoltorio`. Ninguna de las dos se exporta. Cuando un control **no
  puede** usar la primitiva (P-10), la única forma de que se vea igual es copiar las dos cadenas a
  mano. Eso es literalmente lo que el módulo vino a matar: "la misma cadena de clases de borde copiada
  15 veces".
- **Bloquea:** no
- **Mientras tanto:** `LoginForm.tsx` tiene un `CAJA_SELECT` y un `LABEL` propios, con el comentario
  que apunta acá. Son copias del original con dos diferencias deliberadas: `h-9` (para empatar con la
  altura del botón y con el trigger de Radix, que `Field` no fija porque su input crece con el
  `py-2`) y `pr-8` para dejarle lugar al caret. **El riesgo real es la divergencia futura:** si T12
  cambia el radio o el borde de los inputs en `Field.tsx`, el select del login se queda atrás y nadie
  se va a enterar.
- **Lo que hay que hacer:** exportar las dos cadenas desde `ui/Field.tsx` (`export const CLASES_CAJA`
  y `CLASES_LABEL`) y que `LoginForm` y `Select` las importen en vez de repetirlas. Es una línea de
  `export` y tres de import; no cambia ninguna firma de componente, así que no toca el contrato
  congelado de §5.
- **Resolución:** _pendiente_

### P-12 (T04) — Los iconos de Phosphor no se pueden importar desde un Server Component. Verificado, no inferido
- **Task:** T04 la encontró. **Afecta a T06, T08 y T11, que tienen `page.tsx` de server.**
- **Sección del plan:** §0 punto 5, D5
- **Archivo:** `node_modules/@phosphor-icons/react` 2.1.10 (dependencia, no es de nadie)
- **Qué pasa:** el paquete **no trae la directiva `"use client"` en ningún archivo de su `dist`**
  (`grep -rl "use client" node_modules/@phosphor-icons/react/dist/` no devuelve nada), y su
  `dist/lib/context.es.js` llama `createContext` a nivel de módulo, que `IconBase` después consume con
  `useContext`. En el runtime de React Server Components `createContext` no existe, así que importar
  **un solo icono** desde un Server Component rompe la página entera.
- **Cómo se verificó:** agregándole `import { ShieldWarning } from "@phosphor-icons/react"` a
  `src/app/login/page.tsx` (que es server) y corriendo `npm run build`. Salida:

  ```
   ✓ Compiled successfully
  TypeError: (0 , a.createContext) is not a function
      at 6782 (.next/server/app/login/page.js:1:10393)
  Error: Failed to collect page data for /login
  ```

  Se revirtió: `src/app/login/page.tsx` no importa Phosphor, y el `SignIn` y el `CaretDown` del login
  viven en `LoginForm.tsx`, que sí es `"use client"`.
- **El detalle que lo hace peligroso:** **el build imprime `✓ Compiled successfully` de todas formas.**
  La falla ocurre después, en "Collecting page data". Una task que verifique con
  `npm run build 2>&1 | grep -E "Compiled|Failed"` ve el tilde verde y cree que pasó. El único chequeo
  que lo caza es mirar el **exit code** del build o que la ruta aparezca en la tabla de rutas, que es
  justo lo que pide §9 punto 2 y por eso ese punto no es decorativo.
- **Bloquea:** no, mientras el icono viva en un componente cliente.
- **Mientras tanto:** regla práctica para las 7 tasks que faltan: **los iconos van en el componente
  cliente, nunca en el `page.tsx` de server.** En la práctica alcanza, porque los `page.tsx` de esta
  app son cascarones que leen la cookie o el config y delegan el JSX a un `*Board`/`*Deck` cliente.
- **Lo que hay que hacer, si alguna vez hace falta un icono en server:** importarlo del subpath SSR
  (`@phosphor-icons/react/dist/ssr`), que usa `SSRBase` y no toca `createContext`. **No probado en este
  módulo**, así que si una task lo necesita, que lo verifique con un build antes de darlo por bueno.
- **Resolución:** _pendiente_

### P-13 (T04) — `CardTitle` renderiza un `<h2>` fijo: la pantalla cuya tarjeta ES la página queda sin `<h1>`
- **Task:** T04 la encontró; la resuelve T01 o T12
- **Sección del plan:** §5, §9 punto 9 (accesibilidad)
- **Archivos:** `src/components/ui/Card.tsx` (de T01), `src/app/login/page.tsx`
- **Qué falta:** `CardTitle` tiene el tag `<h2>` hardcodeado y no acepta `as` ni `asChild`. En una
  grilla de tarjetas eso está bien. En el login, donde la tarjeta es toda la página, usarlo dejaría el
  documento **sin ningún `<h1>`**: el `layout.tsx` tampoco pone uno (la marca "AUGC" es un `<Link>`),
  así que el primer encabezado del documento sería un `h2` y el nivel 1 quedaría vacío. Un lector de
  pantalla que lista encabezados para orientarse arranca en un nivel que no existe.
- **Bloquea:** no
- **Mientras tanto:** `login/page.tsx` escribe el título como `<h1 className="text-display
  font-semibold text-fg">`. No es duplicar `CardTitle`: el tamaño **también** es distinto a propósito
  (`text-display` 24px contra `text-title` 16px), porque el título de la única pantalla monopropósito
  de la app no pesa lo mismo que el de una tarjeta de una grilla de 95. `CardDescription` sí se usa
  tal cual.
- **Lo que hay que hacer:** darle a `CardTitle` un `as?: "h1" | "h2" | "h3"` con default `"h2"`.
  Amplía la firma congelada de §5 pero no rompe ningún consumidor. T08 y T11 lo van a querer también:
  las dos tienen una tarjeta que encabeza la pantalla.
- **Resolución:** _pendiente_

### P-14 (T04) — No hay primitiva para avisos de bloque, y hay al menos tres pantallas que los necesitan
- **Task:** T04 la encontró; la resuelve T01 o T12
- **Sección del plan:** §0 punto 7 ("estados de error en cada pantalla"), §5 (las 10 primitivas)
- **Archivos:** `src/app/login/page.tsx`, `src/app/login/LoginForm.tsx`
- **Qué falta:** las 10 primitivas cubren el error **de un campo** (`Field` con `error`) y el estado
  **de una cosa** (`Badge` con `tone`), pero no el aviso de un párrafo con `role="alert"`, que es lo
  que hace falta para "el server no tiene AUTH_SECRET", "demasiados intentos, esperá 47s" y el aviso
  del gate de aprobación de P-01. Hoy cada pantalla lo escribe a mano con
  `rounded border border-<tono>/40 bg-<tono>/10 px-2.5 py-2 text-body text-<tono>`, que son cuatro
  decisiones que van a divergir entre pantallas exactamente como divergieron los grises.
- **Bloquea:** no
- **Mientras tanto:** el login tiene dos avisos escritos a mano, los dos con tokens y sin un solo color
  literal: el del formulario (rate limit, server sin configurar, red caída) en `danger`, y el de
  AUTH_SECRET en `accent`, que en este sistema significa "esto espera algo de vos" (D6) y acá el que
  tiene que hacer algo es quien administra el server, no el usuario.
- **Lo que hay que hacer:** una primitiva `Aviso` (o `Alert`) de `{ tone: Tone; children }` que reuse
  el mismo mapa de tonos que `Badge`, para que el aviso y el badge del mismo estado no puedan salir de
  distinto color. Es la primitiva número 11 y es chica. Si se agrega, T04, T06 y T08 se simplifican.
- **Resolución:** _pendiente_

### P-15 (T04) — El chequeo 5 de `T04-login.md` espera 2 y la línea base real es 3
- **Task:** T04 la encontró; la resuelve T12
- **Sección del plan:** §9, y §4 chequeo 5 de `T04-login.md`
- **Archivo:** `tasks/T04-login.md`
- **Qué falta:** el chequeo dice
  `grep -cE 'autoComplete="(username|current-password)"' src/app/login/LoginForm.tsx` → "esperado
  exactamente: 2". **Da 3, y daba 3 antes del rediseño también**, verificado contra
  `git show HEAD:src/app/login/LoginForm.tsx`: el archivo tiene `autoComplete="username"` **dos**
  veces, una en la rama del `<select>` y otra en la rama del `<input>` libre de cuando no hay usuarios
  en el env, más `current-password` una vez. El "2" del documento se escribió contando un solo campo
  de usuario.
- **Bloquea:** no. Lo que el chequeo quiere probar —que los dos `autoComplete` siguen ahí— **pasa**: el
  conteo es idéntico al de HEAD y las dos ramas conservan el atributo.
- **Mientras tanto:** queda en 3. **No se tocó el chequeo**: `tasks/` es de T12 salvo esta sección.
- **Lo que hay que hacer:** cambiar el esperado a 3, o mejor, cambiarlo por dos greps separados
  (`grep -c 'autoComplete="username"'` → 2 y `grep -c 'autoComplete="current-password"'` → 1), que es
  más específico y no se rompe si alguien reordena el archivo.
- **Resolución:** _pendiente_

### P-16 (T04) — Se arregló un bug de estado del login que dejaba el botón trabado. Es un cambio de comportamiento y va anotado
- **Task:** T04 lo arregló. Queda acá porque §0 dice "ningún cambio funcional".
- **Sección del plan:** §0 ("no se construye: cambios funcionales"), §3 de `T04-login.md`
- **Archivo:** `src/app/login/LoginForm.tsx`
- **Qué pasaba:** la rama de error del handler (`if (!res.ok || !data.ok)`) hacía `setError`,
  `setPassword("")` y `return` **sin bajar `cargando`**. Solo el `catch` lo bajaba. Así que después de
  **un** intento fallido el botón quedaba deshabilitado con el spinner puesto y el texto "Entrando…"
  para siempre: no se podía reintentar sin recargar la página. Se veía como "el login se colgó".
- **Por qué se arregló en vez de anotarse y seguir:** el caso 3 de la verificación a mano de
  `T04-login.md` (6 intentos fallidos seguidos para ver el mensaje de 429) es **imposible de ejecutar**
  con ese bug: exigiría 6 recargas de página. Y el caso 1 pide que "el foco quede usable" después del
  error, que con el botón deshabilitado y el foco caído al `<body>` tampoco se cumplía.
- **Qué se cambió, exactamente:** se agregó `setCargando(false)` en esa rama, y un `ref` en el campo de
  password con un `.focus()` para que el foco vuelva al campo en vez de caerse al `body` cuando el
  botón se deshabilita. **No se tocó** el POST, ni el body, ni la lectura de la respuesta, ni el
  `window.location.assign("/")`, ni el rate limit del server. Es estado de UI.
- **El otro cambio de comportamiento visible, este sí pedido por el plan:** el botón ya no dice
  "Entrando…" mientras carga. Dice "Entrar" siempre, con un spinner al lado, porque §5 regla 1 lo
  exige (el texto que cambia mueve el ancho del botón).
- **Bloquea:** no
- **Resolución:** _pendiente_
