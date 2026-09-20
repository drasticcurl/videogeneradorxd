"use client";

/**
 * Las dos pestañas de /imagenes: "Generar" (ImagenesBoard, de siempre) y
 * "Generador masivo" (GeneradorMasivo, nueva).
 *
 * Componente cliente aparte y no adentro de `page.tsx` porque `page.tsx` es Server
 * Component (resuelve el catalogo de modelos server-side, ver su comentario) y
 * `Tabs` de Radix necesita cliente.
 *
 * NO CONTROLADO (`defaultValue`, sin `value`/`onValueChange`): a diferencia de
 * `ProjectTabs` (que sincroniza con la URL porque cada pestaña ES una ruta distinta),
 * acá las dos pestañas viven en la MISMA ruta `/imagenes`. Poner la pestaña activa en
 * la URL chocaria con `?id=` que ya usa `ImagenesBoard` para el proyecto abierto, y
 * mezclar los dos parametros no aporta nada: ir a "Generador masivo" y volver no
 * necesita ser un link compartible.
 */
import { Sparkle, StackSimple } from "@phosphor-icons/react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui";
import type { ModelOption } from "@/lib/config";

import GeneradorMasivo from "./GeneradorMasivo";
import ImagenesBoard from "./ImagenesBoard";

export default function ImagenesTabs({
  modelos,
  modeloDefault,
}: {
  modelos: ModelOption[];
  modeloDefault: string;
}) {
  return (
    <Tabs defaultValue="generar">
      <TabsList>
        <TabsTrigger value="generar">
          <span className="inline-flex items-center gap-1.5">
            <Sparkle aria-hidden className="size-3.5" />
            Generar
          </span>
        </TabsTrigger>
        <TabsTrigger value="masivo">
          <span className="inline-flex items-center gap-1.5">
            <StackSimple aria-hidden className="size-3.5" />
            Generador masivo
          </span>
        </TabsTrigger>
      </TabsList>

      <TabsContent value="generar">
        <ImagenesBoard modelos={modelos} modeloDefault={modeloDefault} />
      </TabsContent>
      <TabsContent value="masivo">
        <GeneradorMasivo />
      </TabsContent>
    </Tabs>
  );
}
