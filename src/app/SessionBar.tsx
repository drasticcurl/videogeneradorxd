"use client";

/**
 * Nombre del usuario logueado + boton de salir, para el header.
 *
 * Es cliente porque el logout es un fetch y despues navega. El nombre se lo pasa
 * el layout, que lo resuelve en el server leyendo la cookie httpOnly (el cliente
 * no puede leerla, y eso es lo que impide que un XSS se la lleve).
 *
 * El rediseño toco SOLO el JSX. La funcion `salir()` quedo igual, incluido el
 * `window.location.assign`: ver el comentario adentro, es un bug conocido.
 */

import { SignOut } from "@phosphor-icons/react";
import { useState } from "react";

import { Button } from "@/components/ui";

export default function SessionBar({ usuario }: { usuario: string }) {
  const [saliendo, setSaliendo] = useState(false);

  async function salir() {
    setSaliendo(true);
    try {
      await fetch("/api/login", { method: "DELETE" });
    } catch {
      // Si el fetch falla igual mandamos al login: la cookie puede haber quedado,
      // pero el usuario ve una pantalla coherente y el proximo request la valida.
    }
    /**
     * Carga completa, por el mismo motivo que el login (ver LoginForm.tsx).
     * `router.refresh()` volveria a pedir el RSC de la ruta actual, que ya no
     * tiene cookie: el redirect lo haria el middleware en medio de un refresh, que
     * es el mismo caso fragil que rompia el login. Y una carga completa tiene un
     * segundo beneficio al salir: tira el Router Cache del cliente, asi que no
     * queda ninguna pantalla con datos de la sesion vieja en memoria del browser.
     */
    window.location.assign("/login");
  }

  return (
    <span className="flex items-center gap-2 border-l border-divider pl-4">
      {/*
        El nombre en mono: son usuarios de dos o tres letras en mayuscula y con la
        proporcional quedaban con el interletrado desparejo al lado del boton.
      */}
      <span className="code text-label text-fg-dim">{usuario.toUpperCase()}</span>
      {/*
        `loading` deshabilita y pone el spinner PERO no cambia el texto (§5, regla 1):
        antes pasaba de "Salir" a "Saliendo…", cambiaba de ancho y corria el header
        entero justo cuando el usuario lo estaba mirando.
      */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={salir}
        loading={saliendo}
        icon={<SignOut aria-hidden className="size-3.5 shrink-0" />}
      >
        Salir
      </Button>
    </span>
  );
}
