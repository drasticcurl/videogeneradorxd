// Configuracion de Remotion (usada por el CLI y el Studio).
//
// El render de produccion se realiza por SSR desde `render.mjs`
// (bundle() + selectComposition() + renderMedia()), por lo que aqui solo se
// fijan valores por defecto utiles para el desarrollo y para la coherencia del
// codec de salida con el pipeline de Python (H.264 / MP4).
import {Config} from '@remotion/cli/config';

// Formato de imagen intermedio de los frames: JPEG es el mas rapido (no se
// requiere transparencia para subtitulos quemados sobre el video de fondo).
Config.setVideoImageFormat('jpeg');

// Codec de video por defecto: H.264 (MP4), coherente con `renderMedia({codec: 'h264'})`.
Config.setCodec('h264');

// Sobrecarga de Webpack (identidad): punto de extension si en el futuro se
// necesitan loaders adicionales. `render.mjs` pasa esta misma funcion a bundle().
Config.overrideWebpackConfig((config) => config);
