// Capa de textos extra tipo "hook": overlays de TEXTO PLANO renderizados
// SOBRE el video final. A diferencia de `Captions.tsx`, aqui NO hay animacion
// (ni fade, ni translateY, ni interpolate): el texto simplemente aparece y
// desaparece de forma abrupta segun su ventana temporal.
//
// IMPORTANTE: existen DOS copias de este archivo que DEBEN quedar IDENTICAS
// (byte a byte) entre si:
//   - remotion/src/TextosExtraLayer.tsx               (render SSR con Node)
//   - frontend/components/remotion/TextosExtraLayer.tsx (navegador con @remotion/player)
// La composicion se renderiza tanto en SSR como en el navegador y ambas
// necesitan el mismo overlay. La UNICA diferencia permitida entre las dos
// copias de la composicion es el subcomponente `FondoVideo`, que NO vive en
// este archivo; por tanto `TextosExtraLayer.tsx` debe ser identico en ambos
// lugares.
//
// Flujo (segun pseudocodigo del diseño §7.4):
//  1. Se calcula el tiempo actual en ms: (frame / fps) * 1000.
//  2. Para cada texto extra, se muestra SOLO si esta dentro de su intervalo
//     [inicioMs, finMs) (inicio incluido, fin excluido).
//  3. Cada texto visible se pinta en un <div> de posicion absoluta centrado en
//     (posHorizontalPct%, posVerticalPct%) mediante translate(-50%, -50%),
//     aplicando fuente/tamano/color/negrita y borde/outline si corresponde.
import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import type {TextoExtraProps} from './types';

type TextosExtraLayerProps = {
  textosExtra: TextoExtraProps[];
};

export const TextosExtraLayer: React.FC<TextosExtraLayerProps> = ({
  textosExtra,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  // Sin textos extra no se pinta nada.
  if (!textosExtra || textosExtra.length === 0) {
    return null;
  }

  // (1) Tiempo actual del render en milisegundos.
  const ms = (frame / fps) * 1000;

  return (
    <AbsoluteFill>
      {textosExtra.map((t, i) => {
        // (2) Ventana temporal [inicioMs, finMs): inicio incluido, fin
        // excluido. Fuera de la ventana el texto no se renderiza.
        const visible = ms >= t.inicioMs && ms < t.finMs;
        if (!visible) {
          return null;
        }

        // Posicion del centro del texto en porcentaje (clamp a 0..100).
        const topPct = Math.min(Math.max(t.estilo.posVerticalPct, 0), 100);
        const leftPct = Math.min(Math.max(t.estilo.posHorizontalPct, 0), 100);

        // Peso de la fuente: negrita (700) o normal (400) segun el estilo.
        const fontWeight = t.estilo.negrita ? 700 : 400;

        // Borde/outline del texto: solo si grosorBorde > 0. Se dibuja con
        // WebkitTextStroke y paintOrder 'stroke fill' para que el trazo quede
        // DETRAS del relleno (mismo enfoque que `Captions.tsx`). `paintOrder`
        // no esta tipado en todas las versiones de CSSProperties, por eso se
        // castea el objeto de estilo del borde a React.CSSProperties.
        const estiloBorde: React.CSSProperties =
          t.estilo.grosorBorde > 0
            ? ({
                WebkitTextStroke: `${t.estilo.grosorBorde}px ${t.estilo.colorBorde}`,
                paintOrder: 'stroke fill',
              } as React.CSSProperties)
            : {};

        return (
          <div
            key={i}
            style={{
              // (3) Posicion absoluta centrada en (leftPct%, topPct%).
              // translate(-50%, -50%) situa el CENTRO del bloque en ese punto.
              position: 'absolute',
              top: `${topPct}%`,
              left: `${leftPct}%`,
              transform: 'translate(-50%, -50%)',
              // Ancho maximo ~85% para que los textos largos hagan salto de
              // linea de forma natural en lugar de desbordar.
              maxWidth: '85%',
              textAlign: 'center',
              fontFamily: t.estilo.fuente,
              fontSize: t.estilo.tamano,
              color: t.estilo.color,
              fontWeight,
              lineHeight: 1.2,
              textShadow: '0 2px 8px rgba(0,0,0,0.6)',
              // TEXTO PLANO: sin opacidad animada ni transiciones.
              ...estiloBorde,
            }}
          >
            {t.texto}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
