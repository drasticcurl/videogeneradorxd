import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "AUGC Pipeline",
  description:
    "Genera anuncios UGC (imagenes + videos) en cadena con Vertex AI. Todo guardado localmente.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
            <nav className="flex items-center gap-4 text-sm text-slate-300">
              <Link href="/" className="hover:text-white">
                Nuevo proyecto
              </Link>
              <a
                href="https://cloud.google.com/vertex-ai/generative-ai/docs"
                target="_blank"
                rel="noreferrer"
                className="hover:text-white"
              >
                Docs Vertex AI
              </a>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
