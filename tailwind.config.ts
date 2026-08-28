import type { Config } from "tailwindcss";

/**
 * Tokens de diseño. FUENTE DE VERDAD UNICA de los colores.
 *
 * Ninguna pantalla escribe un color literal: ni `#hex`, ni `zinc-700`, ni
 * `slate-800`. Solo estos nombres. Es lo que evita el problema que tenia la app
 * antes, con cinco grises distintos repartidos en cinco pantallas y ningun lugar
 * donde cambiarlos.
 *
 * Los valores estan verificados en `tasks/_verificacion-contraste.mjs`: 15 pares,
 * WCAG AA, 0 fallos. Si hace falta un par nuevo, se agrega ahi PRIMERO y se corre.
 */
const config: Config = {
  content: [
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // ─── Superficies ────────────────────────────────────────────────────
        bg: "#09090b", // zinc-950, fondo de la app
        surface: "#18181b", // zinc-900, tarjetas y paneles
        "surface-hi": "#27272a", // zinc-800, hover e inputs

        // ─── Bordes: SON DOS, y no es un descuido ───────────────────────────
        // WCAG 1.4.11 exige 3:1 para el borde de un componente INTERACTIVO.
        // Verificado: zinc-600 da 2.57:1, zinc-700 1.91:1 y zinc-800 1.34:1, o sea
        // que ninguno sirve. El minimo real es zinc-500.
        // Pero un separador decorativo NO es un componente y no tiene que pasar
        // nada, y usar zinc-500 para separar grita. De ahi los dos tokens.
        border: "#71717a", // zinc-500, inputs y todo lo enfocable
        divider: "#27272a", // zinc-800, separar bloques

        // ─── Texto ──────────────────────────────────────────────────────────
        fg: "#fafafa", // zinc-50
        // El texto mas apagado que existe. NO bajar a zinc-500: da 4.12:1 y no
        // pasa AA. Verificado.
        "fg-dim": "#a1a1aa", // zinc-400

        // ─── Acento, uno solo ───────────────────────────────────────────────
        // Ambar y no indigo por dos razones. La medible: el indigo-500 que usaba
        // la app da 4.45:1 como texto y 4.28:1 con texto claro encima, o sea que
        // NO pasa AA en ningun sentido. La otra: el violeta/indigo es el tell
        // visual mas reconocible de interfaz generada.
        // En esta app el acento significa "esto espera algo de vos", y por eso el
        // estado `awaiting_approval` usa el mismo color: es coherente, no una
        // colision.
        accent: "#fbbf24", // amber-400
        "on-accent": "#09090b", // texto sobre el acento

        // ─── Estados: escala FUNCIONAL, aparte del acento ───────────────────
        ok: "#34d399", // emerald-400, terminado
        danger: "#fb7185", // rose-400, fallo
        info: "#38bdf8", // sky-400, la maquina esta trabajando

        // Acá vivieron `ink` y `panel`, los alias de transicion que T01 dejo para que
        // las pantallas sin migrar no quedaran sin estilos mientras el rediseño
        // avanzaba de a una. T12 los borro despues de probar que no quedaba ni una
        // referencia en `src/`. `accent` NO era un alias: es un token de §4 y se
        // queda.
      },
      fontFamily: {
        // Las define `layout.tsx` con next/font. El fallback importa: si la
        // variable no cargara, cae en la del sistema y no en Times.
        sans: ["var(--font-geist-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      fontSize: {
        // Escala cerrada, 4 niveles. No hay nada por debajo de 12px: la app tenia
        // 194 usos de text-xs o menor y por eso no habia jerarquia, todo gritaba
        // bajito.
        label: ["0.75rem", { lineHeight: "1rem", letterSpacing: "0.02em" }], // 12
        body: ["0.875rem", { lineHeight: "1.375rem" }], // 14
        title: ["1rem", { lineHeight: "1.5rem" }], // 16
        display: ["1.5rem", { lineHeight: "2rem", letterSpacing: "-0.01em" }], // 24
      },
      borderRadius: {
        // Tres radios y nada mas. `rounded-full` solo para el punto de estado.
        sm: "4px", // inputs, badges
        md: "6px", // botones
        lg: "10px", // tarjetas, paneles
      },
      transitionDuration: {
        DEFAULT: "150ms",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
