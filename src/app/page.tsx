"use client";
/**
 * Home `/`: lista de proyectos de video, o el wizard de "Nuevo proyecto".
 *
 * Rediseño VISUAL: este archivo pasa de ser un formulario largo de ~1160 lineas a
 * ser un orquestador chico que alterna entre dos pantallas:
 *   - `HomeProyectos`      el listado con filtros, seleccion y cards con progreso.
 *   - `NuevoProyectoWizard` el wizard de 3 pasos que reemplaza al formulario largo.
 *
 * Ningun fetch, payload ni accion del store cambio de lugar: se MOVIERON de archivo,
 * no de comportamiento. Ver el header de cada uno para el detalle.
 *
 * `reset()` + `loadConfig()` siguen corriendo una sola vez al montar, como antes
 * (antes tambien disparaba `loadProjects`; ahora ese fetch vive en `HomeProyectos`,
 * que se monta siempre — la vista del wizard convive en el mismo arbol, oculta con
 * CSS y no desmontada, para no perder el estado del formulario si el usuario mira el
 * listado a mitad de armar el plan).
 */
import { useEffect, useState } from "react";

import { PantallaScroll } from "@/components/Pantalla";
import { Button } from "@/components/ui";
import { useProjectStore } from "@/store/useProjectStore";

import { HomeProyectos } from "./HomeProyectos";
import { NuevoProyectoWizard } from "./NuevoProyectoWizard";

type Vista = "lista" | "nuevo";

export default function HomePage() {
  const { loadConfig, reset } = useProjectStore();
  const [vista, setVista] = useState<Vista>("lista");
  // Se incrementa cada vez que el wizard crea un proyecto (solo o en lote), para
  // que HomeProyectos vuelva a pedir /api/projects y la card nueva aparezca sin
  // que el usuario tenga que refrescar la pagina a mano.
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    reset();
    loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sin `reset()` acá: el store ya se resetea una vez al montar. Resetear al abrir
  // el wizard borraba el brief a medio armar cada vez que el usuario iba al listado
  // y volvía, y pisaba el brief de ejemplo que el EmptyState carga justo antes de
  // llamar a esta función.
  function handleNuevoProyecto() {
    setVista("nuevo");
  }

  function handleCreado() {
    setRefreshKey((k) => k + 1);
  }

  // Las dos vistas se renderizan SIEMPRE y se alternan con `hidden`. Antes era un
  // early return, y "← Volver a proyectos" desmontaba el wizard: el paso, el nombre
  // y todo lo que vive en su estado local se perdía (ver el header).
  return (
    <>
      <div className={vista === "nuevo" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <div className="flex items-center gap-3 border-b border-divider px-4 py-3 sm:px-6">
          <Button variant="ghost" size="sm" onClick={() => setVista("lista")}>
            ← Volver a proyectos
          </Button>
          <h1 className="text-title font-semibold text-fg">Nuevo proyecto</h1>
        </div>
        <NuevoProyectoWizard onCreado={handleCreado} />
      </div>
      <div className={vista === "lista" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <PantallaScroll>
          <HomeProyectos onNuevoProyecto={handleNuevoProyecto} refreshKey={refreshKey} />
        </PantallaScroll>
      </div>
    </>
  );
}
