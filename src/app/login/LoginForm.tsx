"use client";

/**
 * Form de login. Manda usuario + password por POST a /api/login y, si entra, hace
 * una carga de pagina COMPLETA a `/`.
 *
 * El porque de la carga completa esta explicado en detalle en el handler de abajo:
 * arregla un bug donde la password CORRECTA terminaba en un error del server y la
 * incorrecta se comportaba bien. No lo cambies por `router.push` sin leer eso.
 *
 * ─── QUE TOCO EL REDISEÑO Y QUE NO ──────────────────────────────────────────
 *
 * Toco SOLO la presentacion: el POST, su body, la lectura de la respuesta y la
 * navegacion posterior quedaron identicos. Lo unico que cambio en el handler es
 * COMO se guarda el error para mostrarlo (ahora sabe si es del campo o del
 * formulario) y que el foco vuelve al campo de password cuando falla.
 *
 * ─── POR QUE EL <select> SIGUE SIENDO NATIVO Y NO EL `Select` DE T01 ─────────
 *
 * Ver P-10 en §10 del plan, que salio de esta task. Resumen: el `Select` de T01
 * envuelve Radix, que renderiza un `<button role="combobox">` y no un `<select>`,
 * y su firma congelada no expone `name` ni `autoComplete`. Los gestores de
 * contraseñas emparejan el campo de usuario con el de password por esos dos
 * atributos, y este es el unico formulario de la app donde eso importa. Entre
 * romper el autofill de los dos usuarios y no usar la primitiva, no usar la
 * primitiva es mucho mas barato.
 *
 * Accesibilidad: los dos controles tienen su `<label>` asociado por `htmlFor`; el
 * error del campo lo pone `Input` con `aria-describedby` + `aria-invalid`, y el
 * del formulario va en un `role="alert"` dentro de un `aria-live`.
 */

import { CaretDown, SignIn } from "@phosphor-icons/react";
import { useRef, useState } from "react";

import { Button, Input } from "@/components/ui";

/**
 * Las clases de la caja del `<select>` nativo, copiadas de las que usan `Field` y
 * `Select` de T01 para que el control se vea igual que el resto del sistema.
 *
 * Que esto sea un copy-paste es el sintoma de P-11 (§10): `ui/Field.tsx` no exporta
 * su const `CAJA`, asi que un control que no puede usar la primitiva tiene que
 * repetir la cadena a mano, que es exactamente el problema que el modulo vino a
 * matar. `h-9` para que empate con la altura del boton y con el trigger de Radix.
 */
const CAJA_SELECT =
  "h-9 w-full cursor-pointer appearance-none rounded-sm border border-border bg-bg " +
  "pl-2.5 pr-8 text-body text-fg transition-colors hover:bg-surface-hi " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

const LABEL = "mb-1 block text-label font-medium text-fg-dim";

/**
 * Un error del campo (la password esta mal) se muestra pegado al campo. Uno del
 * formulario (rate limit, server sin configurar, red caida) no es culpa de lo que
 * el usuario escribio, asi que va aparte y arriba del boton.
 */
type Fallo = { mensaje: string; ambito: "campo" | "formulario" };

export default function LoginForm({ usuarios }: { usuarios: string[] }) {
  const [usuario, setUsuario] = useState(usuarios[0] ?? "");
  const [password, setPassword] = useState("");
  const [fallo, setFallo] = useState<Fallo | null>(null);
  const [cargando, setCargando] = useState(false);
  const refPassword = useRef<HTMLInputElement>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFallo(null);
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
        setFallo({
          mensaje: data.error ?? `Error ${res.status}`,
          // 401 es "usuario o password incorrectos": es del campo. El 429 del rate
          // limit (que ya viene con los segundos desde el server) y el 503 de
          // "falta AUTH_SECRET" son del server, y mostrarlos colgados del input
          // haria parecer que el problema es lo que se escribio.
          ambito: res.status === 401 ? "campo" : "formulario",
        });
        setPassword("");
        // Al vaciar la password el boton se deshabilita, y si el submit vino de un
        // click el foco estaba ahi: se caeria al body y con teclado habria que
        // volver a tabular desde arriba. Lo devolvemos al campo que hay que
        // corregir, que ademas es donde esta el mensaje.
        refPassword.current?.focus();
        /**
         * ESTE `setCargando(false)` ES NUEVO, y arregla un bug de estado que tenia
         * la version anterior: esta rama hacia `return` sin bajar `cargando`, asi
         * que despues de UN intento fallido el boton quedaba deshabilitado con el
         * spinner puesto para siempre y no se podia reintentar sin recargar la
         * pagina. Se veia como "el login se colgo".
         *
         * No cambia nada del auth: no toca el fetch, ni el body, ni la navegacion.
         * Es estado de UI. Hacia falta ademas para poder probar el caso 3 de la
         * verificacion a mano (6 intentos fallidos seguidos para ver el 429), que
         * antes exigia 6 recargas.
         */
        setCargando(false);
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
      setFallo({
        mensaje: err instanceof Error ? err.message : "Error de red",
        ambito: "formulario",
      });
      setCargando(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-4">
      {usuarios.length > 0 ? (
        <div>
          <label htmlFor="usuario" className={LABEL}>
            Usuario
          </label>
          {/* `relative` para el caret: con `appearance-none` el nativo deja de
              dibujar el suyo, y sin flecha no se lee como desplegable. */}
          <div className="relative">
            <select
              id="usuario"
              name="usuario"
              value={usuario}
              onChange={(e) => setUsuario(e.target.value)}
              autoComplete="username"
              className={CAJA_SELECT}
            >
              {usuarios.map((u) => (
                <option key={u} value={u}>
                  {u.toUpperCase()}
                </option>
              ))}
            </select>
            <CaretDown
              aria-hidden
              className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-dim"
            />
          </div>
        </div>
      ) : (
        // Sin ningun PASSWORD_<NOMBRE> en el env no hay lista que elegir, asi que
        // el campo es libre. En esta rama si entra la primitiva completa, porque
        // `Input` acepta `name` y `autoComplete` como cualquier input.
        <Input
          id="usuario"
          name="usuario"
          label="Usuario"
          type="text"
          value={usuario}
          onChange={(e) => setUsuario(e.target.value)}
          autoComplete="username"
          required
        />
      )}

      {/*
        El error del campo lo renderiza `Input` debajo del input y lo ata con
        `aria-describedby`, asi que queda pegado a lo que fallo en vez de suelto
        arriba del boton, que era donde estaba antes.
      */}
      <Input
        ref={refPassword}
        id="password"
        name="password"
        label="Password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
        required
        error={fallo?.ambito === "campo" ? fallo.mensaje : undefined}
      />

      {/* aria-live: el aviso aparece despues del submit. El contenedor existe
          siempre para que el lector de pantalla lo tenga registrado antes de que
          haya texto adentro. */}
      <div aria-live="polite">
        {fallo?.ambito === "formulario" && (
          <p
            role="alert"
            className="rounded-sm border border-danger/40 bg-danger/10 px-2.5 py-2 text-body text-danger"
          >
            {fallo.mensaje}
          </p>
        )}
      </div>

      {/*
        `loading` deshabilita y pone el spinner, pero NO cambia el texto (§5, regla
        1): antes pasaba de "Entrar" a "Entrando…" y el boton cambiaba de ancho
        justo en el unico momento en que el usuario lo esta mirando.

        `disabled` y `loading` por separado reproducen el `cargando ||
        password.length === 0` de antes: `Button` ya hace `disabled || loading`.
      */}
      <Button
        type="submit"
        variant="primary"
        className="w-full"
        loading={cargando}
        disabled={password.length === 0}
        icon={<SignIn aria-hidden className="size-4 shrink-0" />}
      >
        Entrar
      </Button>
    </form>
  );
}
