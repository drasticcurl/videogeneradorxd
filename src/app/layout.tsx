import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import "./globals.css";

import { currentUser } from "@/lib/auth";

import SessionBar from "./SessionBar";

export const metadata: Metadata = {
  title: "AUGC Pipeline",
  description:
    "Genera anuncios UGC (imagenes + videos) en cadena con Vertex AI. Todo guardado localmente.",
  // La app corre en un subdominio publico y es interna: no se indexa.
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Se lee en el server: la cookie es httpOnly y el cliente no la ve. Esto hace
  // dinamico el layout, que en esta app no cambia nada (todas las rutas ya son
  // `force-dynamic`: es una herramienta interna, no hay nada prerenderizable).
  const usuario = currentUser(cookies());

  return (
    <html lang="es">
      <body className="min-h-screen">
        <header className="border-b border-slate-800 bg-panel/60 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
            <Link href="/" className="flex items-center gap-2 font-semibold">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-accent text-sm font-bold text-white">
                A
              </span>
              <span>AUGC Pipeline</span>
            </Link>
            {/* Sin sesion el header queda solo con la marca: los links no llevan
                a ningun lado porque el middleware los redirige al login. */}
            {usuario && (
              <nav className="flex items-center gap-4 text-sm text-slate-300">
                <Link href="/" className="hover:text-white">
                  Nuevo proyecto
                </Link>
                <Link href="/batch" className="hover:text-white">
                  Tablero
                </Link>
                <Link href="/imagenes" className="hover:text-white">
                  Imágenes
                </Link>
                <a
                  href="https://cloud.google.com/vertex-ai/generative-ai/docs"
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-white"
                >
                  Docs Vertex AI
                </a>
                <SessionBar usuario={usuario} />
              </nav>
            )}
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
