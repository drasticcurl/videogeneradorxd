# Bugfix Requirements Document

## Introduction

En Cloud Run, algunos trabajos de edición que reciben clips previamente generados y almacenados en el bucket quedan detenidos en el 25% correspondiente a «Unir», sin producir el resultado ni comunicar un estado que permita actuar. Esta corrección debe garantizar que la unión abandone ese punto mediante un avance válido o un fallo accionable, aportar evidencia suficiente para diagnosticar bloqueos y permitir identificar visualmente la versión desplegada.

El alcance se limita al flujo de unión de clips existentes. El flujo separado que extiende un clip siete segundos debe permanecer independiente y conservar su comportamiento.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN un trabajo de edición ejecutado en Cloud Run recibe clips previamente generados, almacenados en el bucket y aceptados sin errores de validación, y el progreso informado alcanza el 25% correspondiente a «Unir» THEN las consultas posteriores continúan informando 25%, no se produce el resultado unido y el trabajo no informa finalización, fallo ni una solicitud de intervención del usuario.

1.2 WHEN un trabajo deja de avanzar después de informar 25% y antes de iniciar el paso posterior a «Unir» THEN el sondeo continúa respondiendo, pero no permite determinar la última operación iniciada o terminada ni informa un fallo accionable.

1.3 WHEN el editor responde a la solicitud HTTP y el trabajo continúa en segundo plano THEN no existe evidencia que identifique la revisión y su configuración efectiva de CPU para confirmar o descartar throttling.

1.4 WHEN la revisión inicia e intenta unir los clips THEN no existe evidencia vinculada a esa revisión que confirme la disponibilidad, ejecución y versión de los binarios reales de ffmpeg y ffprobe.

1.5 WHEN los clips proceden del bucket THEN no se puede distinguir, para cada clip, entre su lectura, materialización temporal, inspección y entrega a ffmpeg.

1.6 WHEN el usuario consulta la aplicación THEN no se muestra junto a «AUGC Pipeline» una versión manual que incluya al menos un número y una palabra.

### Expected Behavior (Correct)

2.1 WHEN un trabajo de edición ejecutado en Cloud Run recibe clips previamente generados, almacenados en el bucket y aceptados sin errores de validación, y el progreso informado alcanza el 25% correspondiente a «Unir» THEN el sistema SHALL validar que todos y únicamente los clips solicitados sean legibles, puedan inspeccionarse, tengan una duración válida, se materialicen y se unan una sola vez en el orden solicitado, y SHALL abandonar el 25% hacia un estado posterior o terminal.

2.2 WHEN una operación susceptible de bloqueo alcanza su plazo finito configurable sin terminar correctamente THEN el sistema SHALL cancelarla, no aceptar ninguna salida parcial, conservar intactas las entradas, registrar la última operación iniciada o terminada y marcar el trabajo como fallido con el paso y el motivo visibles para el usuario.

2.3 WHEN el editor responde a la solicitud HTTP y el trabajo continúa en segundo plano THEN el sistema SHALL permitir comprobar la política efectiva de CPU de la revisión y correlacionar con el trabajo los logs generados después de la respuesta HTTP, de modo que pueda confirmarse o descartarse throttling sin inferir la configuración únicamente desde el repositorio.

2.4 WHEN una revisión inicia antes de procesar trabajos de edición THEN el sistema SHALL comprobar que ffmpeg y ffprobe arrancan, informan su versión y terminan correctamente; si cualquiera de estas comprobaciones falla, el sistema SHALL impedir o rechazar el procesamiento e informar una causa accionable.

2.5 WHEN los clips proceden del bucket y se preparan para «Unir» THEN el sistema SHALL registrar eventos correlacionables por revisión, trabajo y clip para su existencia, lectura, materialización temporal, inspección y unión, sin registrar ni exponer contenido audiovisual.

2.6 WHEN el usuario consulta cualquier pantalla de la aplicación THEN el sistema SHALL mostrar junto a «AUGC Pipeline» una versión manual consistente en todas las pantallas, de longitud razonable y con al menos un número y una palabra; el valor inicial de esta corrección SHALL ser `v0.9123 banana xD`, salvo que el diseño posterior fundamente otro valor.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN el flujo de unión procesa clips válidos en un entorno local THEN el sistema SHALL CONTINUE TO funcionar y continuar el pipeline con el comportamiento existente.

3.2 WHEN se unen clips previamente generados y almacenados en el bucket THEN el sistema SHALL CONTINUE TO respetar exactamente la selección y el orden solicitados, sin omitir, duplicar ni reordenar clips, y SHALL CONTINUE TO mantener inmutables byte a byte los objetos de entrada del bucket.

3.3 WHEN se ejecuta el flujo «Unir» descrito en este bugfix THEN el sistema SHALL CONTINUE TO mantenerlo totalmente separado del flujo que extiende un clip siete segundos, sin iniciar ni alterar ese flujo de extensión.

3.4 WHEN el trabajo tiene etapas configuradas después de «Unir» o estados de interacción THEN el sistema SHALL CONTINUE TO no iniciar ninguna etapa posterior antes de que la unión termine correctamente y SHALL CONTINUE TO conservar los estados de interacción existentes.

3.5 WHEN el proceso se ejecuta con las mismas entradas, opciones y entorno que antes de la corrección THEN el sistema SHALL CONTINUE TO producir una salida funcional equivalente a la del proceso existente, sin exigir igualdad byte a byte cuando la codificación no sea determinista.

3.6 WHEN una operación informa un error explícito THEN el sistema SHALL CONTINUE TO detener el paso afectado, marcar el trabajo como fallido, no exponer resultados parciales como exitosos y mostrar el paso y el motivo correspondientes.

3.7 WHEN la interfaz consulta el progreso de un trabajo THEN el sistema SHALL CONTINUE TO usar el mecanismo de sondeo y los estados existentes, incluidos los estados de interacción, completado y fallido, sin imponer un intervalo de sondeo no respaldado por la configuración o el comportamiento vigente.
