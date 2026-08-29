"use client";

/**
 * Visor a pantalla completa para una imagen o un video.
 *
 * Existe porque las tarjetas de las grillas son chicas por definicion: mostrar 40
 * imagenes o 95 clips a la vez obliga a que cada uno sea una miniatura, y despues hay
 * que decidir si eso sirve o se regenera, que es una decision que cuesta plata. La
 * miniatura es para encontrar; el visor es para decidir.
 *
 * NO vive en `components/ui/`: esa carpeta son las primitivas del sistema de diseño con
 * firma congelada. Esto es un componente de aplicacion.
 *
 * `object-contain` con el alto acotado al viewport: se ve COMPLETO en cualquier formato,
 * de 21:9 a 9:16, sin recortes y sin desbordar la pantalla.
 */
import { DownloadSimple, X } from "@phosphor-icons/react";
import { useEffect } from "react";

export interface VisorProps {
  url: string;
  titulo: string;
  /** "image" pinta un <img>; "video" pinta un <video> con controles. */
  tipo: "image" | "video";
  onCerrar: () => void;
}

export function Visor({ url, titulo, tipo, onCerrar }: VisorProps) {
  // Escape cierra: es lo que uno aprieta sin pensar cuando algo se abre encima.
  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCerrar();
    };
    window.addEventListener("keydown", alTeclear);
    return () => window.removeEventListener("keydown", alTeclear);
  }, [onCerrar]);

  // `?` o `&` segun si la url ya trae query (los archivos llevan ?v= de cache-busting).
  const urlDescarga = `${url}${url.includes("?") ? "&" : "?"}dl=1`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Vista ampliada de ${titulo}`}
      onClick={onCerrar}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-bg/95 p-4"
    >
      <div className="flex w-full max-w-5xl items-center justify-between gap-3">
        <span className="code truncate text-label text-fg-dim">{titulo}</span>
        <span className="flex shrink-0 gap-2">
          <a
            href={urlDescarga}
            download
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1.5 rounded-md bg-surface px-2.5 py-1.5 text-label text-fg-dim transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <DownloadSimple aria-hidden className="size-3.5" />
            Descargar
          </a>
          <button
            type="button"
            onClick={onCerrar}
            aria-label="Cerrar la vista ampliada"
            className="inline-flex items-center gap-1.5 rounded-md bg-surface px-2.5 py-1.5 text-label text-fg-dim transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X aria-hidden className="size-3.5" />
            Cerrar (Esc)
          </button>
        </span>
      </div>

      {/* stopPropagation en el medio: clickear la imagen para pausar o mover el video
          no tiene que cerrar el visor. Cerrar es clickear el fondo. */}
      {tipo === "video" ? (
        <video
          src={url}
          controls
          autoPlay
          playsInline
          onClick={(e) => e.stopPropagation()}
          className="max-h-[85vh] max-w-full rounded-lg bg-bg"
        />
      ) : (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={url}
          alt={titulo}
          onClick={(e) => e.stopPropagation()}
          className="max-h-[85vh] max-w-full rounded-lg object-contain"
        />
      )}
    </div>
  );
}
