// Root de Remotion: declara la composicion `ShortVideo`.
//
// La duracion, el fps y las dimensiones son DINAMICOS: se derivan de los
// `inputProps` que envia Python (props.json) mediante `calculateMetadata`
// (patron recomendado por Remotion para metadatos dinamicos). Los valores
// pasados como props del <Composition> son solo un fallback razonable para el
// Studio cuando no hay inputProps.
import React from 'react';
import {Composition, type CalculateMetadataFunction} from 'remotion';
import {ShortVideo} from './ShortVideo';
import type {ShortVideoProps} from './types';

// Identificador de la composicion. Debe coincidir con el `id` que usa
// selectComposition() en render.mjs y con el contrato del backend ("ShortVideo").
export const SHORT_VIDEO_ID = 'ShortVideo';

// Props por defecto para el Studio (se sobreescriben con los inputProps reales).
// videoSrc: '' => fondo blanco (playground); grupos: [] => sin subtitulos.
const defaultProps: ShortVideoProps = {
  videoSrc: '',
  fps: 30,
  width: 1080,
  height: 1920,
  durationInFrames: 30,
  estilo: {
    fuente: 'Inter',
    tamano: 72,
    color: '#FFFFFF',
    colorResaltado: '#FFE100',
    posVerticalPct: 80,
    animEntradaMs: 150,
    colorBorde: '#000000',
    grosorBorde: 6,
    negrita: true,
  },
  combineTokensWithinMs: 1200,
  grupos: [],
  // Retrocompatibilidad del Studio: sin textos extra por defecto (lista vacia).
  // Un props.json real sobreescribe este valor con los overlays enviados por
  // el backend.
  textosExtra: [],
};

// Deriva fps/durationInFrames/width/height desde los inputProps (Req 9.1).
// Se aplican minimos defensivos para que un props degenerado no rompa el render.
const calculateMetadata: CalculateMetadataFunction<ShortVideoProps> = ({props}) => {
  const fps = props.fps > 0 ? Math.round(props.fps) : defaultProps.fps;
  const durationInFrames =
    props.durationInFrames > 0 ? Math.round(props.durationInFrames) : 1;
  const width = props.width > 0 ? Math.round(props.width) : defaultProps.width;
  const height = props.height > 0 ? Math.round(props.height) : defaultProps.height;

  return {
    fps,
    durationInFrames,
    width,
    height,
    props,
  };
};

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id={SHORT_VIDEO_ID}
      component={ShortVideo}
      // Valores de fallback para el Studio; los reales llegan por calculateMetadata.
      durationInFrames={defaultProps.durationInFrames}
      fps={defaultProps.fps}
      width={defaultProps.width}
      height={defaultProps.height}
      defaultProps={defaultProps}
      calculateMetadata={calculateMetadata}
    />
  );
};
