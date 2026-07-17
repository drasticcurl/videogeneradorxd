# Bugfix Requirements Document

## Introduction

Esta especificación documenta una segunda iteración del fallo persistente del flujo de edición en Cloud Run. En la evidencia disponible, el último estado observado permanece en 25%, la interfaz muestra «Unir» y no aparece el timeline de edición de silencios al procesar clips previamente generados cuyos archivos de origen están en el bucket.

El bugfix anterior incorporó salvaguardas de timeout y manejo de procesos mediante `Popen`, pero la evidencia actual no demuestra que esos mecanismos sean la causa del comportamiento observado. El porcentaje 25 no permite determinar por sí solo si `UNIR` finalizó, si comenzó la detección de silencios ni qué paso, subpaso o estado está activo. Esta iteración debe hacer observables esas transiciones y aportar evidencia correlacionada suficiente para diagnosticar el trabajo sin atribuir causas no demostradas.

El alcance corresponde exclusivamente al flujo de edición de clips existentes. El flujo separado que extiende un clip siete segundos queda fuera de este bugfix y debe permanecer aislado en ambos sentidos.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN un usuario inicia en Cloud Run una edición de clips válidos previamente generados y almacenados en el bucket, con la edición de silencios habilitada, THEN el último estado de la evidencia disponible permanece en 25%, la interfaz muestra «Unir» y no aparece el timeline de edición de silencios.

1.2 WHEN el progreso observado permanece en 25% THEN el sistema no permite determinar, a partir de ese porcentaje, si `UNIR` finalizó, si comenzó la detección de silencios ni cuál es el paso, subpaso o estado actual.

1.3 WHEN se analiza un trabajo afectado con la evidencia disponible THEN el sistema todavía no permite clasificarlo entre estas cuatro categorías: (a) bloqueo de ffmpeg o ffprobe antes de finalizar `UNIR`; (b) bloqueo durante la detección de silencios; (c) unión y detección completadas sin transición o propagación visible de `ESPERANDO_EDICION_SILENCIOS`; o (d) ejecución de una revisión antigua o de una configuración distinta de la esperada.

1.4 WHEN se considera el bugfix anterior durante el diagnóstico THEN existen salvaguardas de timeout y manejo mediante `Popen`, pero no hay evidencia que establezca una relación causal entre ellas y el incidente actual.

1.5 WHEN se reconstruye un trabajo afectado a través del generador, el editor y Cloud Run THEN falta un registro correlacionado de extremo a extremo que reúna, en cada evento relevante, la versión de la aplicación, la revisión desplegada, el `editJobId`, el `editorJobId`, el paso, el subpaso y el estado.

1.6 WHEN se inspecciona la revisión que atendió un trabajo afectado THEN no se confirma para esa revisión si la CPU está configurada efectivamente como always allocated ni la disponibilidad y las versiones efectivas de ffmpeg y ffprobe.

1.7 WHEN una operación alcanza su límite de tiempo sin completarse THEN el trabajo puede continuar en un estado no terminal, sin un fallo accionable y correlacionado que identifique el paso, el subpaso y el motivo.

1.8 WHEN el usuario visualiza el título `AUGC Pipeline` THEN la versión exacta `v0.9123 banana xD` no aparece junto al título, y la ubicación actual de la versión no demuestra por sí sola su coherencia con `/api/version` para el mismo build y la misma revisión.

### Expected Behavior (Correct)

2.1 WHEN un usuario inicia en Cloud Run una edición de clips válidos previamente generados y almacenados en el bucket, con la edición de silencios habilitada, THEN el sistema SHALL emitir eventos diferenciados para la finalización de `UNIR`, el inicio de la detección de silencios, la finalización de la detección de silencios y la pausa `ESPERANDO_EDICION_SILENCIOS`, y SHALL presentar el timeline correspondiente.

2.2 WHEN varios eventos del flujo comparten el porcentaje 25 THEN el sistema SHALL cambiar y exponer el paso, el subpaso o el estado según corresponda a cada transición, aunque el porcentaje permanezca en 25.

2.3 WHEN se diagnostica un trabajo afectado THEN el sistema SHALL proporcionar evidencia suficiente para asignarle una categoría primaria entre: (a) bloqueo de ffmpeg o ffprobe antes de finalizar `UNIR`; (b) bloqueo durante la detección de silencios; (c) unión y detección completadas sin transición o propagación visible de `ESPERANDO_EDICION_SILENCIOS`; o (d) ejecución de una revisión antigua o de una configuración distinta de la esperada; y SHALL registrar los hechos que sustentan esa clasificación.

2.4 WHEN el diagnóstico considera las salvaguardas existentes de timeout y `Popen` THEN el sistema SHALL tratarlas como mecanismos ya implementados y SHALL atribuir causalidad únicamente cuando exista evidencia correlacionada del trabajo y de la revisión que la sustente.

2.5 WHEN el sistema registra un evento de inicio, finalización, pausa, timeout o fallo durante una edición THEN el evento SHALL incluir la correlación completa entre la versión de la aplicación, la revisión desplegada, el `editJobId`, el `editorJobId`, el paso, el subpaso y el estado aplicables.

2.6 WHEN una revisión vaya a procesar trabajos de edición THEN el sistema SHALL comprobar en el entorno efectivo de esa revisión, y no solo en la configuración declarada, que la CPU está configurada como always allocated y que ffmpeg y ffprobe están disponibles, pueden ejecutarse e informan sus versiones; si esta comprobación previa o preflight falla, el sistema SHALL impedir el procesamiento y producir un fallo accionable y correlacionado, sin publicar resultados parciales.

2.7 WHEN una operación alcanza su timeout sin completarse THEN el sistema SHALL llevar el trabajo al estado terminal `FALLIDO` con un fallo accionable y correlacionado que identifique el paso, el subpaso y el motivo, y SHALL descartar cualquier salida parcial como resultado exitoso.

2.8 WHEN el usuario visualiza el título `AUGC Pipeline` THEN el sistema SHALL mostrar junto a ese título la cadena exacta `v0.9123 banana xD`.

2.9 WHEN la interfaz muestra `v0.9123 banana xD` junto al título `AUGC Pipeline` THEN el sistema SHALL exponer el mismo identificador mediante `/api/version`, y ambos valores SHALL corresponder al mismo build y a la misma revisión que atiende la solicitud.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN el flujo procesa una selección de clips previamente generados THEN el sistema SHALL CONTINUE TO incluir todos y solo los clips seleccionados, exactamente una vez y en el orden solicitado.

3.2 WHEN el flujo lee o materializa clips de origen THEN el sistema SHALL CONTINUE TO mantener intactos, byte a byte, los objetos de entrada y escribir los resultados y archivos temporales únicamente en destinos separados.

3.3 WHEN el editor se ejecuta en modo local con entradas válidas THEN el sistema SHALL CONTINUE TO funcionar de forma independiente de Cloud Run y de sus metadatos o servicios exclusivos.

3.4 WHEN se modifica el flujo de edición y unión descrito en esta especificación o el flujo que extiende un clip siete segundos THEN el sistema SHALL CONTINUE TO mantener ambos flujos separados en los dos sentidos, sin compartir disparadores, estados ni cambios específicos de uno con el otro.

3.5 WHEN una operación externa finaliza o alcanza un timeout THEN el sistema SHALL CONTINUE TO conservar las garantías existentes de `Popen`, drenaje de salida, límites de espera, terminación, limpieza de procesos y propagación de errores, sin introducir ni presuponer valores nuevos de timeout.

3.6 WHEN los silencios están habilitados y la unión y la detección finalizan correctamente THEN el sistema SHALL CONTINUE TO conservar el video unido y los tramos detectados durante la pausa, presentar el timeline y no iniciar la transcripción ni pasos posteriores antes de que concluya dicha pausa.

3.7 WHEN los silencios están deshabilitados THEN el sistema SHALL CONTINUE TO omitir la pausa de edición de silencios y avanzar por el flujo existente sin presentar el timeline.

3.8 WHEN la interfaz consulta el progreso de un trabajo THEN el sistema SHALL CONTINUE TO mantener el progreso porcentual monótono, mientras el estado y el subpaso permanecen independientes del porcentaje y pueden cambiar aunque este no cambie.
