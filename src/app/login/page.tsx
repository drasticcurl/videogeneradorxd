"use client";
/**
 * Página de login. Postea la contraseña a /api/auth/login; si es correcta, el backend
 * setea la cookie de sesión y volvemos a la app (al `next` o a "/").
 */
import { useState } from "react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError((data && (data.error as string)) || "No se pudo iniciar sesión");
        setBusy(false);
        return;
      }
      // Volvemos a donde queríamos ir (o al home).
      const params = new URLSearchParams(window.location.search);
      const next = params.get("next") || "/";
      window.location.href = next.startsWith("/") ? next : "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-sm flex-col justify-center">
      <div className="rounded-xl border border-slate-700 bg-panel p-6 shadow-xl">
        <h1 className="text-lg font-semibold text-slate-100">Acceso</h1>
        <p className="mt-1 text-sm text-slate-400">
          Esta app está protegida. Ingresá la contraseña para continuar.
        </p>
        <form onSubmit={submit} className="mt-4 space-y-3">
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Contraseña"
            className="w-full rounded-lg border border-slate-600 bg-ink px-3 py-2 text-sm focus:border-accent focus:outline-none"
          />
          {error && <p className="text-sm text-red-300">{error}</p>}
          <button
            type="submit"
            disabled={busy || !password}
            className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Entrando…" : "Entrar"}
          </button>
        </form>
      </div>
    </div>
  );
}
