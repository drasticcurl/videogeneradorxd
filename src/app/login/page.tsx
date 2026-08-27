/**
 * Pantalla de login.
 *
 * Es la unica pagina que el middleware deja pasar sin cookie. Si ya hay sesion
 * valida, redirige a la home en vez de mostrar el form otra vez.
 *
 * El chequeo de sesion se hace en el server (`currentUser`, con node:crypto), no
 * en el cliente: el cliente no puede leer la cookie porque es httpOnly, que es
 * justamente lo que impide que un XSS se la robe.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { currentUser, listUsers, isConfigured } from "@/lib/auth";

import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Entrar · AUGC Pipeline",
  robots: { index: false, follow: false },
};

export default function LoginPage() {
  if (currentUser(cookies())) {
    redirect("/");
  }

  return (
    <div className="mx-auto mt-10 max-w-sm">
      <div className="rounded-xl border border-slate-800 bg-panel/60 p-6">
        <h1 className="text-lg font-semibold">Entrar</h1>
        <p className="mt-1 text-sm text-slate-400">
          Herramienta interna. Generar consume cuota facturable de Vertex AI.
        </p>

        {isConfigured() ? (
          <LoginForm usuarios={listUsers()} />
        ) : (
          <p
            role="alert"
            className="mt-4 rounded-md border border-amber-800 bg-amber-950/40 px-3 py-2 text-sm text-amber-200"
          >
            El server no tiene el login configurado: faltan <code>AUTH_SECRET</code>{" "}
            o las vars <code>PASSWORD_&lt;NOMBRE&gt;</code>. Hasta que estén, no
            puede entrar nadie.
          </p>
        )}
      </div>
    </div>
  );
}
