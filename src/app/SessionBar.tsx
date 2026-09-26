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
 *
 * El nombre es ademas el boton de "Tu cuenta de Vertex" (CuentaVertexDialog): el color
 * dice de un vistazo si generás con la tuya o con la compartida. Los fetch de la cuenta
 * viven en el dialogo y no aca, asi este archivo sigue llamando solo a /api/login.
 */

import { SignOut } from "@phosphor-icons/react";
import { useState } from "react";

import CuentaVertexDialog from "@/components/CuentaVertexDialog";
import { Badge, Button } from "@/components/ui";
import type { EstadoCuentaVertex } from "@/lib/types";
import { estadoDeCuentaVertex } from "@/lib/ui-tokens";

export default function SessionBar({
  usuario,
  cuentaVertex,
}: {
  usuario: string;
  /** Resuelta en el server por el layout; el dialogo la actualiza al cargar o quitar. */
  cuentaVertex: EstadoCuentaVertex;
}) {
  const [saliendo, setSaliendo] = useState(false);
  const [cuenta, setCuenta] = useState(cuentaVertex);
  const [verCuenta, setVerCuenta] = useState(false);
  // En mock no se gasta nada: el nombre queda neutro para no pedir una accion que no hace falta.
  const visual =
    cuenta.modo === "vertex"
      ? estadoDeCuentaVertex(cuenta.origen)
      : { tone: "neutral" as const, label: "Modo de prueba (mock)" };
  const resumen = `Tu cuenta de Vertex: ${visual.label}${cuenta.proyecto ? ` · ${cuenta.proyecto}` : ""}`;

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
    <span className="flex items-center gap-2 sm:border-l sm:border-divider sm:pl-4">
      {/*
        El nombre en mono: son usuarios de dos o tres letras en mayuscula y con la
        proporcional quedaban con el interletrado desparejo al lado del boton.
        `px-1`: el badge ya trae su relleno, y con el del boton el nombre quedaba lejos
        del divisor.
      */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="px-1"
        onClick={() => setVerCuenta(true)}
        aria-label={resumen}
        title={resumen}
      >
        <Badge tone={visual.tone} punto={cuenta.modo === "vertex"} className="code">
          {usuario.toUpperCase()}
        </Badge>
      </Button>
      <CuentaVertexDialog
        abierto={verCuenta}
        onCambio={setVerCuenta}
        estado={cuenta}
        onEstado={setCuenta}
      />
      {/*
        `loading` deshabilita y pone el spinner PERO no cambia el texto (§5, regla 1):
        antes pasaba de "Salir" a "Saliendo…", cambiaba de ancho y corria el header
        entero justo cuando el usuario lo estaba mirando.
      */}
      {/*
        Abajo de 640px queda solo el icono y el texto se esconde: los tres links del
        nav mas el nombre mas "Salir" no entraban a lo ancho en un telefono. El
        `aria-label` es el que sostiene el nombre accesible cuando el texto no se ve,
        asi que el boton sigue anunciandose "Salir" en el lector de pantalla.
      */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={salir}
        loading={saliendo}
        aria-label="Salir"
        icon={<SignOut aria-hidden className="size-3.5 shrink-0" />}
      >
        <span className="hidden sm:inline">Salir</span>
      </Button>
    </span>
  );
}
