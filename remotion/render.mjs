// Entrypoint SSR del motor de render Remotion (Req 9.1, 9.3, 9.4).
//
// Invocado por el backend Python (backend/app/engine/remotion.py) como:
//     node render.mjs
// con las rutas pasadas por variables de entorno (NO por la linea de comandos,
// Req 12.4):
//     PROPS_PATH -> ruta del props.json a leer (inputProps de la composicion)
//     OUT_PATH   -> ruta del MP4 de salida a producir
//
// Flujo: bundle() [cacheado] -> selectComposition({id: 'ShortVideo'}) ->
// renderMedia({codec: 'h264', outputLocation: OUT_PATH}). Ante cualquier error
// se sale con codigo != 0 para que Python lo detecte como RemotionError.
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {bundle} from '@remotion/bundler';
import {renderMedia, selectComposition} from '@remotion/renderer';

// Id de la composicion (debe coincidir con Root.tsx y con el backend).
const COMPOSITION_ID = 'ShortVideo';

// Directorio de este archivo, para resolver el entryPoint con independencia
// del directorio de trabajo desde el que Python invoque `node`.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY_POINT = path.resolve(__dirname, 'src', 'index.ts');

// Cache del bundle a nivel de modulo: si el proceso renderiza varias veces,
// bundle() solo se recompila si cambia el codigo fuente (Req 9.1). bundle()
// ademas mantiene su propio cache de Webpack (enableCaching por defecto).
let serveUrlCache = null;

async function obtenerServeUrl() {
  if (serveUrlCache) {
    return serveUrlCache;
  }
  serveUrlCache = await bundle({
    entryPoint: ENTRY_POINT,
    // Misma sobrecarga (identidad) que remotion.config.ts.
    webpackOverride: (config) => config,
  });
  return serveUrlCache;
}

async function main() {
  const propsPath = process.env.PROPS_PATH;
  const outPath = process.env.OUT_PATH;

  if (!propsPath) {
    throw new Error('Falta la variable de entorno PROPS_PATH');
  }
  if (!outPath) {
    throw new Error('Falta la variable de entorno OUT_PATH');
  }

  // inputProps que produjo Python (contrato ShortVideoProps).
  const inputProps = JSON.parse(readFileSync(propsPath, 'utf-8'));

  // bundle() cacheado.
  const serveUrl = await obtenerServeUrl();

  // selectComposition evalua calculateMetadata con los mismos inputProps para
  // derivar fps/durationInFrames/width/height (Req 9.1).
  const composition = await selectComposition({
    serveUrl,
    id: COMPOSITION_ID,
    inputProps,
  });

  // Render final a MP4 (H.264). Se pasan los mismos inputProps que a
  // selectComposition (requisito de Remotion).
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    outputLocation: outPath,
    inputProps,
  });
}

main()
  .then(() => {
    // Exito: codigo 0. Python valida ademas la existencia del artefacto.
    process.exit(0);
  })
  .catch((err) => {
    // Fallo: se imprime a stderr y se sale con codigo != 0 (Req 9.4). Python
    // lo traducira a RemotionError y el Job pasara a FALLIDO (sin fallback).
    console.error('[remotion] Error durante el render:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
