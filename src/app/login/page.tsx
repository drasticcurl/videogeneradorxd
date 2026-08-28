/**
 * Pantalla de login.
 *
 * Es la unica pagina que el middleware deja pasar sin cookie. Si ya hay sesion
 * valida, redirige a la home en vez de mostrar el form otra vez.
 *
 * El chequeo de sesion se hace en el server (`currentUser`, con node:crypto), no
 * en el cliente: el cliente no puede leer la cookie porque es httpOnly, que es
 * justamente lo que impide que un XSS se la robe.
 *
 * ─── SIN ICONOS DE PHOSPHOR EN ESTE ARCHIVO ─────────────────────────────────
 *
 * Es un Server Component y `@phosphor-icons/react` 2.1.10 no trae la directiva
 * "use client": su `IconBase` consume un `createContext`, asi que importarlo desde
 * el server rompe el build. Los iconos del login viven en `LoginForm.tsx`, que si
 * es cliente. Ver P-12 en §10 del plan.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { Card, CardDescription } from "@/components/ui";
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

  const configurado = isConfigured();

  return (
    // Centrado, que es lo correcto SOLO aca: es la unica pantalla de la app con un
    // proposito unico y sin datos que mostrar al costado.
    <div className="mx-auto mt-10 max-w-sm">
      {/* `p-6` en vez del `p-4` que trae `Card`: es la unica tarjeta que ocupa la
          pantalla entera, y con el padding de una tarjeta de grilla queda apretada. */}
      <Card className="p-6">
        {/*
          `<h1>` a mano y no `CardTitle`, por dos razones. La primera es de tamaño:
          esta es la unica pantalla donde el titulo de la tarjeta ES el titulo de la
          pagina, y le corresponde `text-display` (24px) y no el `text-title` (16px)
          de una tarjeta de grilla. La segunda es que `CardTitle` renderiza un `<h2>`
          fijo, asi que usarlo dejaria la pagina sin `<h1>`. Anotado como P-13 en §10.
        */}
        <h1 className="text-display font-semibold text-fg">Entrar</h1>
        <CardDescription className="mt-1.5">
          Herramienta interna. Generar consume cuota facturable de Vertex AI.
        </CardDescription>

        {configurado ? (
          <LoginForm usuarios={listUsers()} />
        ) : (
          /*
            Sin AUTH_SECRET no entra nadie, asi que no se muestra el form: un
            formulario que rechaza todo es peor que no tenerlo. El aviso usa el
            acento, que en este sistema significa "esto espera algo de vos" (D6);
            aca el que tiene que hacer algo es quien administra el server.

            Va a mano y no con una primitiva porque T01 no dejo ninguna para avisos
            de bloque: `Badge` es para una palabra. Anotado como P-14 en §10.
          */
          <p
            role="alert"
            className="mt-6 rounded-md border border-accent/40 bg-accent/10 px-3 py-2.5 text-body text-fg"
          >
            El server no tiene el login configurado: faltan{" "}
            <code className="font-mono text-accent">AUTH_SECRET</code> o las vars{" "}
            <code className="font-mono text-accent">PASSWORD_&lt;NOMBRE&gt;</code>.
            Hasta que estén, no puede entrar nadie.
          </p>
        )}
      </Card>
    </div>
  );
}
