import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { AUTH_COOKIE } from "@/lib/auth";
import { VersionBanner } from "@/components/VersionBanner";
import { getAppVersion } from "@/lib/version";
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
  // Mostramos "Salir" solo si hay una cookie de sesión (auth activa y logueado).
  const hasSession = Boolean(cookies().get(AUTH_COOKIE)?.value);
  // Deployment identity: the exact manual identifier baked at build time, shown
  // beside the title so the live build/revision is unambiguous (coherent with
  // GET /api/version for the same build). The bottom-right VersionBanner is kept
  // unchanged. (spec `unir-step-hang`, Property 3.)
  const { identifier: appIdentifier } = getAppVersion();
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
              <span
                className="font-mono text-xs font-normal text-slate-400"
                title="Identificador de despliegue (coherente con /api/version)"
                data-testid="deployment-identifier"
              >
                {appIdentifier}
              </span>
            </Link>
            <nav className="flex items-center gap-4 text-sm text-slate-300">
              <Link href="/" className="hover:text-white">
                Nuevo proyecto
              </Link>
              <Link href="/transcribe" className="hover:text-white">
                Transcribir
              </Link>
              <a
                href="https://cloud.google.com/vertex-ai/generative-ai/docs"
                target="_blank"
                rel="noreferrer"
                className="hover:text-white"
              >
                Docs Vertex AI
              </a>
              {hasSession && (
                <a href="/api/auth/logout" className="hover:text-white" title="Cerrar sesión">
                  Salir
                </a>
              )}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
        <VersionBanner />
      </body>
    </html>
  );
}
