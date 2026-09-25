# Prompts para Claude Code — cambio de voz (ElevenLabs)

## Antes de arrancar

La carpeta está descrita en `03-TASKS.md`. Lo que ya **corrió**, no solo se escribió:

```bash
bash tasks/cambio-de-voz/_verificacion-voz.sh | tail -3
#  verde: 10   pendiente: 40   FALLO: 0
```

Y antes de escribir el diseño se corrió con ffmpeg real el circuito de audio completo (§1 de
`02-DISENO.md`):

- el stitch actual sincroniza bien aunque audio y video de un clip duren distinto;
- la pista nueva mide exactamente las mismas muestras que la original (1.057.792);
- el video sale con el mismo md5.

Nadie tiene que volver a demostrar que el enfoque funciona: hay que implementarlo sin romper eso.

### 6 cosas que hay que saber antes de largar el primer agente

**1. T01 va sola y primero.** Declara los tipos, la config, `unido.ts`, `estado.ts` y
`runFfmpegAsync`, que importan T02, T03 y T04. Sin eso, las tres fallan el `tsc` en la primera línea.

**2. T00 necesita la API key de ElevenLabs y un video real. Si ya la tenés, corrélo antes de T03.** Es
el único paso que mide ElevenLabs de verdad (tiempos, facturación, formatos), y cuesta ~US$0,85. Si
el spike dice que ElevenLabs no respeta los tiempos, T03 se escribe en vano. Si todavía no tenés key,
la ola 2 arranca igual: lo que el spike calibra son variables de entorno.

**3. Esto es una app en producción** (`generador.hilvanapp.online`, una sola instancia de PM2, la cola
en memoria), con videos de Veo ya pagados. **Solo T08 toca producción.** Y el repo es **público**: la
API key no entra nunca a un archivo del repo. El chequeo A2 lo vigila en cada corrida.

**4. El riesgo del módulo es silencioso.** Casi todo lo que puede salir mal compila perfecto:

- un tramo corrido un clip;
- un audio que se desfasa 20 ms por tramo;
- una ruta sin chequeo de dueño;
- un DELETE que borra la carpeta antes de cancelar la conversión (y la conversión la recrea).

Por eso cada task corre `_verificacion-voz.sh`, y por eso B15-B19 **ejecutan** la función de tramos
en vez de buscarla con grep.

**5. La trampa de paralelismo está en dos lugares:**

- **`src/lib/ffmpeg.ts`** lo tocan T01 (solo `runFfmpegAsync`) y T04 (solo `stitchProject`), en olas
  distintas.
- **`corrida.ts` (T03) NO importa `voz/index.ts` (T02):** el proveedor llega por parámetro. Si un
  agente "simplifica" eso, T02 y T03 dejan de poder ir en paralelo.

Antes de abrir un archivo, mirá su fila en `03-TASKS.md` §1.

**6. El plan es el contrato.** Las secciones marcadas CONTRATO en `02-DISENO.md` (§4-§11) están
**congeladas**. Lo que el plan no resuelve va a §17, no al código.

## El orden

```
Paso 1   T01  (+ T00 en paralelo si hay key)       1-2 agentes
Paso 2   T02 · T03 · T04                            3 en paralelo
Paso 3   T05 · T06                                  2 en paralelo
Paso 4   T07                                        1 agente
Paso 5   T08                                        1 agente, solo y último, con el usuario
```

**De a uno:** T00 → T01 → T04 → T02 → T03 → T05 → T06 → T07 → T08.

---

## Preámbulo (va al inicio de cada prompt)

> Estás trabajando en `/Users/lucho/Desktop/funnel/videogeneradorxd`, una app Next.js 14 (App Router,
> TypeScript) que genera anuncios UGC, VSLs e imágenes con Vertex AI. **Está en producción** con login
> por usuario y videos de Veo ya pagados. El repo es **público**.
>
> Vas a implementar una parte del módulo "cambio de voz" (Voice Changer de ElevenLabs sobre el video
> unido). Antes de escribir código leé completos `tasks/cambio-de-voz/01-REQUISITOS.md`,
> `tasks/cambio-de-voz/02-DISENO.md` y `tasks/cambio-de-voz/03-TASKS.md`, y después tu task.
>
> Reglas que no se negocian:
> - Solo escribís los archivos de tu fila en `03-TASKS.md` §1. Si necesitás otro, **pará y avisá**.
> - Las secciones CONTRATO del diseño se copian tal cual. Si una no se puede implementar, **pará y
>   avisá**. No la "mejores".
> - Castellano rioplatense en comentarios y UI. Los comentarios explican **por qué** y, cuando
>   documentan una decisión, **el bug que evita**. Los comentarios largos de este repo son
>   deliberados: no los limpies.
> - La API key de ElevenLabs no va en ningún archivo del repo, ni en un log, ni en un mensaje.
> - Tu task no está terminada hasta que corriste **toda** su sección de Verificación y dio lo
>   esperado. Al final corré `bash tasks/cambio-de-voz/_verificacion-voz.sh | tail -3` y reportá la
>   línea `verde / pendiente / FALLO`. FALLO tiene que ser 0.
> - No hagas commit ni push salvo que te lo pidan.

---

## T00 — spike

> [preámbulo]
>
> Tu task es `tasks/cambio-de-voz/T00-spike-elevenlabs.md`. Vas a medir ElevenLabs con audio real de
> Veo antes de que se escriba el motor. La key te la paso en el environment al correr el script
> (`ELEVENLABS_API_KEY=... node tasks/cambio-de-voz/_spike-elevenlabs.mjs <video.mp4>`): no la
> escribas en ningún archivo ni la imprimas. Los audios de salida van a `/tmp/spike-voz/`, fuera del
> repo. Al final dejame las rutas de los dos archivos de 20 s (con y sin ruido de fondo) para
> escucharlos. Si la diferencia de duración pasa el 5 % en algún largo, **pará y avisá** antes de
> cualquier otra cosa: invalida el diseño de §8-§9.

## T01 — fundación (VA SOLA)

> [preámbulo]
>
> Tu task es `tasks/cambio-de-voz/T01-fundacion.md`. Declarás los contratos de §4, §5, §6.1 (solo
> `tipos.ts`), §7.2 y el `runFfmpegAsync` de §9 del diseño. Cinco tasks se escriben contra tus firmas
> al mismo tiempo: copialas tal cual. `runFfmpeg` tiene que comportarse exactamente igual que antes
> (lo usan el stitch y el extend de video). Los dos campos nuevos de `ProjectRecord` son
> **opcionales**. Tu compuerta: B2-B9 en verde, FALLO 0 y `tsc` limpio.

## T02 — proveedores

> [preámbulo]
>
> Tu task es `tasks/cambio-de-voz/T02-proveedores.md`. Implementás `VozProvider` para ElevenLabs (sin
> SDK: `fetch` + `FormData`) y para el mock, el factory por usuario y las favoritas en su propio
> archivo JSON. `elevenlabs.ts` es el **único** archivo del repo que escribe el header `xi-api-key`,
> y recibe la key por parámetro (no lee `process.env`). Nada de `AbortSignal.any`. Tu compuerta:
> B10-B13 en verde, y A2 y A7 siguen en verde.

## T03 — motor

> [preámbulo]
>
> Tu task es `tasks/cambio-de-voz/T03-motor.md`, la más delicada del módulo. `tramos.ts` es **puro**
> (solo `import type`) y tiene que dar exactamente los 5 resultados de §8: el script los ejecuta con
> `node`. `audio.ts` corta por muestra a 48 kHz y copia el video (`-c:v copy`). `corrida.ts` recibe
> el proveedor por parámetro: **no importes `voz/index.ts`**. Relé el proyecto antes de cada
> escritura y tocá solo `versionesVoz`. Si B15-B19 no cierran con una implementación que cumpla las
> reglas de §8, **no toques los esperados del script**: avisá. Tu compuerta: B14-B21 en verde, y la
> prueba con ffmpeg real de la Verificación 5 con muestras iguales y md5 igual.

## T04 — unido con receta

> [preámbulo]
>
> Tu task es `tasks/cambio-de-voz/T04-unido-con-receta.md`. `stitchProject` devuelve la receta del
> unido (§7.1) sin cambiar **nada** del video que produce: ni el grafo, ni los args. La ruta de
> stitch contesta 409 si hay una conversión viva y persiste la receta. Tu compuerta: B22-B23 en
> verde, A1 y A5 siguen en verde, y la Verificación 3 da los tiempos 0-8, 8-16,06 y 16,06-22,06.

## T05 — rutas

> [preámbulo]
>
> Tu task es `tasks/cambio-de-voz/T05-rutas.md`. Las 3 rutas nuevas con exactamente el contrato de
> §11 del diseño, y dos cambios chicos en rutas existentes. El más importante: el `DELETE` del
> proyecto cancela la conversión **antes** de borrar la carpeta. El usuario sale **siempre** de la
> cookie (`requireProjectOwner` / `sessionUser`), nunca del body. Tu compuerta: B24-B28 en verde, y
> A10 sigue en verde. A9 puede marcar SIN USO las rutas nuevas hasta que termine T06: es esperado.

## T06 — UI

> [preámbulo]
>
> Tu task es `tasks/cambio-de-voz/T06-ui.md`. El panel Voz y "Volver a unir" en Resultado (solo en
> `VideoFinal`), el diálogo `CambiarVozDialog` y un mapeo nuevo en `ui-tokens`. Te escribís contra el
> **contrato** HTTP de §11, no contra la implementación de T05, que puede estar corriendo al mismo
> tiempo. Solo primitivas de `@/components/ui` y tokens: nada de colores literales. El `loading` no
> cambia el texto de un botón. El polling se limpia al desmontar. En
> `tasks/_verificacion-endpoints.sh` agregás **una** línea para el diálogo, con su motivo arriba;
> nunca tocás otra. Tu compuerta: B29-B32 en verde, y A8 y A9 en verde.

## T07 — verificación y documentación

> [preámbulo]
>
> Tu task es `tasks/cambio-de-voz/T07-verificacion-y-docs.md`. Escribís y corrés el E2E en mock con
> los 14 casos de §3 (en el patrón de `tasks/_verificacion-ui-funcional.mjs`: sin dependencias, app en
> `:3100`, nunca contra producción), extendés la verificación de UI a Resultado, agregás el guard 3f a
> `deploy.sh` y ponés al día README, CHANGELOG, bitácora y steering. **Si un caso del E2E falla, no lo
> arregles en `src/`**: reportá qué caso, qué esperabas, qué dio y qué task es dueña del archivo. Tu
> compuerta: `VOZ OK (mock)`, `UI OK`, build OK, y `verde: 48  pendiente: 2  FALLO: 0` (quedan B1 y
> B40).

## T08 — producción (VA SOLA Y ÚLTIMA, con el usuario)

> [preámbulo]
>
> Tu task es `tasks/cambio-de-voz/T08-produccion.md`. Esta es la única task que toca producción. La
> key la pone el usuario en `/srv/generador/shared/.env.production`: vos no la ves ni la copiás. No
> deployes con una generación o una conversión corriendo. El QA de §3 se hace con el usuario, que es
> quien juzga la sincronía y la voz. Si la sincronía se ve mal o la key aparece en algún lado:
> `VOICE_PROVIDER=mock`, reload, y avisá. Al final, las resoluciones de P-01, P-02 y P-03 van a §17
> con números, y `_verificacion-voz.sh` tiene que decir `CAMBIO DE VOZ COMPLETO`.
