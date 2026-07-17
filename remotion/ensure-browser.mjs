// Descarga/asegura el Chrome Headless Shell de Remotion en tiempo de build de
// la imagen Docker, usando la API programatica de @remotion/renderer (evita
// depender del binario `remotion` del CLI, que `npx` no resuelve de forma
// fiable en el contenedor). renderMedia lo encuentra despues en runtime.
import {ensureBrowser} from '@remotion/renderer';

await ensureBrowser();
