"use client";

/**
 * "Tu configuración": lo que cada usuario ajusta para SI MISMO. Se abre desde el nombre,
 * arriba a la derecha (SessionBar). Nada de lo de aca cambia a los demas usuarios.
 *
 *   Cuenta de Vertex → con que cuenta de Google Cloud genera (CuentaVertexPanel)
 *   Aprobación       → cuantos clips genera antes de pedir aprobacion (AprobacionPanel)
 *
 * Este archivo no hace fetch: cada pestaña habla con su endpoint. Radix desmonta la
 * pestaña que no se ve, asi que cada una pide su estado fresco al mostrarse.
 */

import { Dialog, DialogContent, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui";
import type { EstadoCuentaVertex } from "@/lib/types";

import AprobacionPanel from "./AprobacionPanel";
import CuentaVertexPanel from "./CuentaVertexPanel";

export default function ConfiguracionDialog({
  abierto,
  onCambio,
  cuenta,
  onCuenta,
}: {
  abierto: boolean;
  onCambio: (v: boolean) => void;
  cuenta: EstadoCuentaVertex;
  onCuenta: (e: EstadoCuentaVertex) => void;
}) {
  return (
    <Dialog open={abierto} onOpenChange={onCambio}>
      <DialogContent
        title="Tu configuración"
        description="Se guarda para tu usuario: no cambia nada de los demás."
        className="w-[min(40rem,calc(100vw-2rem))] max-h-[calc(100vh-2rem)] overflow-y-auto"
      >
        <Tabs defaultValue="vertex">
          <TabsList>
            <TabsTrigger value="vertex">Cuenta de Vertex</TabsTrigger>
            <TabsTrigger value="aprobacion">Aprobación</TabsTrigger>
          </TabsList>
          <TabsContent value="vertex">
            <CuentaVertexPanel estado={cuenta} onEstado={onCuenta} />
          </TabsContent>
          <TabsContent value="aprobacion">
            <AprobacionPanel />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
