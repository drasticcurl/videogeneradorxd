"use client";

/**
 * Form de login. Manda usuario + password por POST a /api/login y, si entra,
 * navega a la home con `router.refresh()` para que el layout server-side vuelva a
 * leer la cookie y muestre el nombre del usuario.
 *
 * Accesibilidad: cada input tiene su `<label>` asociado por `htmlFor`, el error
 * va en un `role="alert"` con `aria-live` para que un lector de pantalla lo
 * anuncie, y el boton informa el estado de carga en texto (no solo visual).
 */

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function LoginForm({ usuarios }: { usuarios: string[] }) {
  const router = useRouter();
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
      // `refresh()` antes de `push()` para que el layout del server vuelva a
      // resolverse con la cookie nueva y aparezca el nombre en el header.
      router.refresh();
      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error de red");
    } finally {
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
