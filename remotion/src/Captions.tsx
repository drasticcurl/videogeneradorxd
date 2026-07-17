// Capa de subtitulos estilo caption clasico + karaoke, renderizada POR GRUPO.
//
// Objetivo visual: una frase (grupo) a la vez, con las palabras SEPARADAS por
// espacios reales y con salto de linea natural si la frase es larga (nada de
// texto pegado en una sola linea). La palabra activa se resalta.
//
// Flujo:
//  1. Se calcula el tiempo actual en ms: (frame / fps) * 1000.
//  2. Se elige el grupo ACTIVO: aquel con startMs <= ms < endMs. Si ninguno
//     coincide, no se muestra nada.
//  3. Se obtienen las palabras a mostrar:
//       - si grupo.words.length > 0 => se usan (llevan timing => karaoke).
//       - si esta vacio => se divide grupo.text por espacios (sin timing).
//  4. Cada palabra se renderiza en su propio <span>, separadas por espacios
//     reales, en un contenedor centrado con flexWrap para que haga salto de
//     linea de forma natural.
//  5. Resaltado palabra-por-palabra si hay timing; si no, todas con color base.
//  6. Animacion de entrada (fade + leve translateY) al inicio del grupo.
//  7. Posicion vertical segun estilo.posVerticalPct.
import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import type {Estilo, Grupo, Palabra} from './types';

type CaptionsProps = {
  grupos: Grupo[];
  estilo: Estilo;
};

export const Captions: React.FC<CaptionsProps> = ({grupos, estilo}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  // Sin grupos no se pinta nada.
  if (!grupos || grupos.length === 0) {
    return null;
  }

  // (1) Tiempo actual del render en milisegundos.
  const ms = (frame / fps) * 1000;

  // (2) Grupo activo: el que contiene el instante actual.
  const grupo = grupos.find((g) => ms >= g.startMs && ms < g.endMs);
  if (!grupo) {
    return null;
  }

  // (3) Palabras a mostrar. Si el grupo trae `words` con timing, se usan tal
  // cual (permiten karaoke). Si no, se divide el texto por espacios y esas
  // palabras NO llevan timing (resaltado desactivado para ellas).
  const conTiming = grupo.words && grupo.words.length > 0;
  const palabras: Palabra[] = conTiming
    ? grupo.words
    : grupo.text
        .split(/\s+/)
        .filter((w) => w.length > 0)
        .map((w) => ({text: w, startMs: 0, endMs: 0}));

  // Si tras dividir no queda ninguna palabra, no se pinta nada.
  if (palabras.length === 0) {
    return null;
  }

  // (6) Animacion de entrada relativa al inicio del grupo (fade + translateY).
  const anim = estilo.animEntradaMs > 0 ? estilo.animEntradaMs : 1;
  const opacidad = interpolate(ms, [grupo.startMs, grupo.startMs + anim], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const desplazamientoY = interpolate(
    ms,
    [grupo.startMs, grupo.startMs + anim],
    [24, 0],
    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
  );

  // (7) Posicion vertical: posVerticalPct (0 arriba, 100 abajo) marca el centro
  // del bloque de subtitulos.
  const topPct = Math.min(Math.max(estilo.posVerticalPct, 0), 100);

  // Peso de la fuente: negrita (700) o normal (400) segun el estilo.
  const fontWeight = estilo.negrita ? 700 : 400;

  // Borde/outline del texto: solo si grosorBorde > 0. Se dibuja con
  // WebkitTextStroke y paintOrder 'stroke fill' para que el trazo quede DETRAS
  // del relleno (evita "comerse" el interior de las letras). `paintOrder` no
  // esta tipado en todas las versiones de CSSProperties, por eso se castea el
  // objeto de estilo del borde a React.CSSProperties.
  const estiloBorde: React.CSSProperties =
    estilo.grosorBorde > 0
      ? ({
          WebkitTextStroke: `${estilo.grosorBorde}px ${estilo.colorBorde}`,
          paintOrder: 'stroke fill',
        } as React.CSSProperties)
      : {};

  return (
    <AbsoluteFill>
      <div
        style={{
          position: 'absolute',
          top: `${topPct}%`,
          left: 0,
          right: 0,
          transform: `translateY(-50%) translateY(${desplazamientoY}px)`,
          opacity: opacidad,
          // Contenedor flex centrado que envuelve las palabras: asi cada frase
          // larga hace salto de linea de forma natural (NO whiteSpace:'pre').
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          alignItems: 'center',
          // Separacion horizontal/vertical entre palabras (ademas del espacio real).
          columnGap: '0.25em',
          rowGap: '0.15em',
          // Ancho maximo ~85% para forzar el salto de linea en frases largas.
          maxWidth: '85%',
          margin: '0 auto',
          textAlign: 'center',
          fontFamily: estilo.fuente,
          fontSize: estilo.tamano,
          fontWeight,
          lineHeight: 1.2,
          textShadow: '0 2px 8px rgba(0,0,0,0.6)',
        }}
      >
        {palabras.map((palabra, i) => {
          // (5) Palabra activa (solo si tiene timing) => color de resaltado.
          const activa =
            conTiming && ms >= palabra.startMs && ms < palabra.endMs;
          return (
            <React.Fragment key={i}>
              <span
                style={{
                  color: activa ? estilo.colorResaltado : estilo.color,
                  // Borde/outline aplicado por palabra (vacio si grosorBorde <= 0).
                  ...estiloBorde,
                }}
              >
                {palabra.text}
              </span>
              {/* Espacio real entre palabras (ademas del gap del flex) para que
                  nunca queden pegadas al copiar/renderizar. */}
              {i < palabras.length - 1 ? ' ' : null}
            </React.Fragment>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
