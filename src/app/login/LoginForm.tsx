"use client";

/**
 * Form de login. Manda usuario + password por POST a /api/login y, si entra, hace
 * una carga de pagina COMPLETA a `/`.
 *
 * El porque de la carga completa esta explicado en detalle en el handler de abajo:
 * arregla un bug donde la password CORRECTA terminaba en un error del server y la
 * incorrecta se comportaba bien. No lo cambies por `router.push` sin leer eso.
 *
 * Accesibilidad: cada input tiene su `<label>` asociado por `htmlFor`, el error
 * va en un `role="alert"` con `aria-live` para que un lector de pantalla lo
 * anuncie, y el boton informa el estado de carga en texto (no solo visual).
 */

import { useState } from "react";

export default function LoginForm({ usuarios }: { usuarios: string[] }) {
  const [usuario, setUsuario] = useState(usuarios[0] ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setCargando(true);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usuario, password }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setError(data.error ?? `Error ${res.status}`);
        setPassword("");
        return;
      }

      /**
       * Carga de pagina COMPLETA, no `router.push()`. No es pereza: es el arreglo
       * de un bug que se veia como "la clave correcta no entra".
       *
       * Lo que habia antes era `router.refresh()` y despues `router.push("/")`.
       * `refresh()` vuelve a pedir el RSC de la ruta ACTUAL, que en ese momento
       * todavia es `/login`. Con la cookie ya seteada, el server component de
       * `/login` llama `redirect("/")`, y un `redirect()` durante un `refresh()`
       * no es una navegacion: Next lo reporta como error de render de Server
       * Components. Resultado: con la password MAL salia el error correcto, y con
       * la password BIEN salia un error del server. Un F5 despues entraba, porque
       * era un GET limpio.
       *
       * `router.push("/")` solo tampoco alcanza: el root layout lee la cookie en
       * el server para mostrar el usuario, y al navegar entre dos rutas que
       * comparten ese layout el App Router puede reusar el layout que ya tiene
       * cacheado en el cliente. El header se quedaria sin el nombre hasta el
       * proximo hard reload.
       *
       * Una carga completa no tiene ninguno de los dos problemas y cuesta un
       * request de mas cada 72 h (el TTL de la sesion). No lo cambies por
       * `router.push` sin releer esto.
       */
      window.location.assign("/");
      // No se baja `cargando`: la navegacion ya esta en curso y volver a
      // habilitar el boton solo invita a un segundo submit.
      return;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error de red");
      setCargando(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-5 space-y-4">
      <div>
        <label
          htmlFor="usuario"
          className="block text-sm font-medium text-slate-300"
        >
          Usuario
        </label>
        {usuarios.length > 0 ? (
          <select
            id="usuario"
            name="usuario"
            value={usuario}
            onChange={(e) => setUsuario(e.target.value)}
            autoComplete="username"
            className="mt-1 w-full rounded-md border border-slate-700 bg-ink px-3 py-2 text-sm text-slate-100 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          >
            {usuarios.map((u) => (
              <option key={u} value={u}>
                {u.toUpperCase()}
              </option>
            ))}
          </select>
        ) : (
          <input
            id="usuario"
            name="usuario"
            type="text"
            value={usuario}
            onChange={(e) => setUsuario(e.target.value)}
            autoComplete="username"
            required
            className="mt-1 w-full rounded-md border border-slate-700 bg-ink px-3 py-2 text-sm text-slate-100 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
        )}
      </div>

      <div>
        <label
          htmlFor="password"
          className="block text-sm font-medium text-slate-300"
        >
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
          className="mt-1 w-full rounded-md border border-slate-700 bg-ink px-3 py-2 text-sm text-slate-100 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      {/* aria-live: el error aparece despues del submit, asi que hay que
          anunciarlo. Sin esto un lector de pantalla no se enteraria. */}
      <div aria-live="polite">
        {error && (
          <p
            role="alert"
            className="rounded-md border border-red-800 bg-red-950/40 px-3 py-2 text-sm text-red-200"
          >
            {error}
          </p>
        )}
      </div>

      <button
        type="submit"
        disabled={cargando || password.length === 0}
        className="w-full rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {cargando ? "Entrando…" : "Entrar"}
      </button>
    </form>
  );
}
