"use client";

/**
 * Nombre del usuario logueado + boton de salir, para el header.
 *
 * Es cliente porque el logout es un fetch y despues navega. El nombre se lo pasa
 * el layout, que lo resuelve en el server leyendo la cookie httpOnly (el cliente
 * no puede leerla, y eso es lo que impide que un XSS se la lleve).
 */

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function SessionBar({ usuario }: { usuario: string }) {
  const router = useRouter();
  const [saliendo, setSaliendo] = useState(false);

  async function salir() {
    setSaliendo(true);
    try {
      await fetch("/api/login", { method: "DELETE" });
    } catch {
      // Si el fetch falla igual mandamos al login: la cookie puede haber quedado,
      // pero el usuario ve una pantalla coherente y el proximo request la valida.
    }
    router.refresh();
    router.push("/login");
  }

  return (
    <span className="flex items-center gap-2 border-l border-slate-700 pl-4">
      <span className="text-slate-400">
        {usuario.toUpperCase()}
      </span>
      <button
        type="button"
        onClick={salir}
        disabled={saliendo}
        className="rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-300 transition hover:border-slate-500 hover:text-white disabled:opacity-50"
      >
        {saliendo ? "Saliendo…" : "Salir"}
      </button>
    </span>
  );
}
