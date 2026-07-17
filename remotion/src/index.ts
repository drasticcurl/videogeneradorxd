// Entrypoint del proyecto Remotion: registra el Root que declara las composiciones.
// Es el `entryPoint` que consume bundle() en render.mjs.
import {registerRoot} from 'remotion';
import {RemotionRoot} from './Root';

registerRoot(RemotionRoot);
