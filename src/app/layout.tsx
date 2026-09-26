import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import "./globals.css";

import { currentUser } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { estadoCuentaVertex } from "@/lib/cuentaVertex";

import NavLinks from "./NavLinks";
import SessionBar from "./SessionBar";

export const metadata: Metadata = {
  title: "AUGC Pipeline",
  description:
    "Genera anuncios UGC (imagenes + videos) en cadena con Vertex AI. Todo guardado localmente.",
  // Herramienta interna en un subdominio publico: no se indexa.
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Se lee en el SERVER: la cookie es httpOnly y el cliente no la ve, que es lo que
  // impide que un XSS se la lleve. Por eso el layout no puede ser "use client" y los
  // links activos viven en <NavLinks />, que es cliente y no toca la sesion.
  const usuario = currentUser(cookies());

  return (
    <html
      lang="es"
      className={cn(GeistSans.variable, GeistMono.variable)}
      suppressHydrationWarning
    >
      {/*
        SHELL DE ALTO FIJO, y es la decision de layout que sostiene el rediseño
        entero: `h-screen flex flex-col overflow-hidden` + header de 56px + main
        `flex-1 min-h-0`. El scroll pasa a vivir ADENTRO de cada columna y no en la
        pagina.

        Por que: las pantallas de trabajo (galeria de imagenes, pipeline de un
        proyecto, revisar) muestran medios 9:16. Con scroll de pagina, para aprobar
        la variante de una tanda habia que bajar hasta el final, y al volver del
        fetch la posicion se perdia. Con el alto fijo la grilla se dimensiona con
        container queries contra el alto REAL disponible y todo entra sin scrollear.

        Consecuencia para quien agregue una pantalla: `main` ya NO trae max-width ni
        padding. Cada pagina elige, con `PantallaScroll` (scrollea, ancho maximo) o
        `PantallaFija` (columnas con su propio scroll). Una pagina que no use
        ninguna de las dos y sea mas alta que el viewport queda CORTADA, porque el
        body es overflow-hidden.
      */}
      <body className="flex h-screen flex-col overflow-hidden bg-bg font-sans text-body text-fg antialiased">
        {/* Salta el nav. Son dos personas que trabajan con teclado y hoy hay que
            tabular los 4 links en cada pantalla para llegar al contenido. */}
        <a
          href="#contenido"
          className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-body focus:text-fg"
        >
          Saltar al contenido
        </a>

        <header className="flex-none border-b border-divider bg-bg">
          {/*
            Ancho completo y ya no `max-w-[1400px] mx-auto`: abajo hay pantallas de
            ancho completo (la galeria de imagenes arranca con un sidebar pegado al
            borde izquierdo) y un header centrado a 1400 dejaba la marca flotando
            lejos del sidebar en un monitor ancho.
          */}
          <div className="flex h-14 items-center gap-3 px-4 sm:gap-6">
            <Link
              href="/"
              className="flex shrink-0 items-center gap-2 rounded-md font-semibold text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span className="inline-flex size-6 items-center justify-center rounded-sm bg-accent text-label font-bold text-on-accent">
                A
              </span>
              <span className="hidden sm:inline">AUGC</span>
            </Link>

            {/* Sin sesion el header queda solo con la marca: los links no llevan a
                ningun lado porque el middleware los redirige al login. */}
            {usuario && (
              <>
                {/*
                  Los controles de sesion quedan AFUERA del <nav>, y no adentro con
                  `ml-auto` como estaban: cuando los tres links y el boton de Salir no
                  entraban a lo ancho (pasaba a 390px, 427px de contenido) el header
                  empujaba y la pagina ENTERA agarraba scroll horizontal. Con el nav
                  como unico `flex-1 min-w-0 overflow-x-auto`, lo que sobra scrollea
                  adentro del nav y el resto del layout no se mueve. De paso Salir no
                  se puede ir de pantalla, que es lo que pasaba antes.
                */}
                <nav
                  aria-label="Principal"
                  className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
                >
                  <NavLinks />
                </nav>
                <span className="flex shrink-0 items-center gap-3">
                  <a
                    href="https://cloud.google.com/vertex-ai/generative-ai/docs"
                    target="_blank"
                    rel="noreferrer"
                    className="hidden rounded-md px-2.5 py-1.5 text-body text-fg-dim transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent lg:inline"
                  >
                    Docs Vertex
                  </a>
                  {/*
                    La cuenta de Vertex llega resuelta del server: el punto de estado
                    del nombre se pinta sin un fetch al abrir cada pantalla.
                  */}
                  <SessionBar
                    usuario={usuario}
                    cuentaVertex={estadoCuentaVertex(usuario)}
                  />
                </span>
              </>
            )}
          </div>
        </header>

        {/*
          Ni `max-w` ni `py`: los pone la pagina, con `PantallaScroll` o
          `PantallaFija` (ver `@/components/Pantalla`). `min-h-0` es lo que permite
          que un hijo con `overflow-y-auto` scrollee: sin eso el hijo crece y
          empuja, y el shell de alto fijo no sirve para nada.
        */}
        <main id="contenido" className="flex min-h-0 flex-1 flex-col">
          {children}
        </main>
      </body>
    </html>
  );
}
