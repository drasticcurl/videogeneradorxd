"""Ejecución del pipeline en background y limpieza del workdir (Tarea 12.3).

El :class:`JobRunner` ejecuta el pipeline completo de un Job **sin bloquear** la
respuesta de ``POST /procesar``: la corrutina :meth:`JobRunner.lanzar` delega el
trabajo intensivo (ffmpeg, whisper) a un hilo del executor mediante
``loop.run_in_executor``, de modo que el bucle de eventos siga libre (Req 10.1).

Al finalizar el Job —tanto en éxito como en error/cancelación— se invoca la
**limpieza del directorio de trabajo** (``JobWorkdir.cleanup``) para no dejar
temporales en disco (Req 13.4, 13.5). El ``Video_Final`` se conserva fuera del
workdir (lo hace el pipeline con ``preservar_video_final``), por lo que sobrevive
a la limpieza.

El progreso se canaliza hacia el :class:`~app.jobs.manager.JobManager`, que es la
fuente de verdad y garantiza la monotonicidad del porcentaje (Req 10.5).

Referencias de requisitos: 10.1, 13.4, 13.5.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable, Optional

from app.engine.pipeline import (
    MOTOR_RENDER_EDICION_FINAL,
    EventoProgreso,
    ReporteProgreso,
    ResultadoPipeline,
    ejecutar_pipeline,
    preparar_grupos_y_pausar,
    reanudar_desde_silencios,
    reanudar_pipeline,
)
from app.models.settings import DEFAULT_MOTOR_RENDER, MotorRender
from app.engine.proc import Runner, ejecutar_comando
from app.jobs.manager import JobManager
from app.storage.workdir import JobWorkdir

logger = logging.getLogger(__name__)

# Resolutor opcional de la ruta del WAV de música a partir del ``musica_id``.
# Por defecto no resuelve música (se implementará junto al endpoint POST /musica).
ResolverMusica = Callable[[Optional[str]], Optional[str]]

# Resolutor de la ruta de archivo de un clip a partir de su ``clip_id``. El
# ``Orden_de_Clips`` de un Job contiene identificadores de clip, pero el pipeline
# (paso UNIR → ``ffprobe``) necesita **rutas** reales. Por defecto es la identidad
# (devuelve el id tal cual) para no romper los tests que usan ids ficticios sin
# archivos en disco; en producción se inyecta un resolutor que hace glob sobre el
# almacén de clips.
ResolverClip = Callable[[str], str]


def _sin_musica(_musica_id: Optional[str]) -> Optional[str]:
    return None


def _identidad_clip(clip_id: str) -> str:
    return clip_id


class JobRunner:
    """Ejecuta el pipeline de un Job en background y limpia sus temporales."""

    def __init__(
        self,
        manager: JobManager,
        *,
        runner: Runner = ejecutar_comando,
        resolver_musica: ResolverMusica = _sin_musica,
        resolver_clip: ResolverClip = _identidad_clip,
        **inyecciones_pipeline: Any,
    ) -> None:
        """Crea el ejecutor.

        Args:
            manager: Gestor de Jobs (fuente de verdad del estado/progreso).
            runner: Ejecutor de comandos externos inyectable.
            resolver_musica: Función que traduce ``musica_id`` a ruta de WAV.
            resolver_clip: Función que traduce cada ``clip_id`` del
                ``Orden_de_Clips`` a la **ruta** de archivo del clip almacenado.
                Por defecto es la identidad (devuelve el id) para no romper los
                tests que usan ids ficticios; en producción se inyecta un
                resolutor que hace glob sobre el almacén de clips.
            **inyecciones_pipeline: Pasos inyectables reenviados a
                :func:`ejecutar_pipeline` (``fn_unir``, ``fn_cortar``, ...),
                útiles en pruebas.
        """
        self.manager = manager
        self.runner = runner
        self.resolver_musica = resolver_musica
        self.resolver_clip = resolver_clip
        self._inyecciones = inyecciones_pipeline

    def _crear_reporter(self, job_id: str) -> ReporteProgreso:
        """Crea un reporter que canaliza los eventos del pipeline al Gestor."""

        def reportar(evento: EventoProgreso) -> None:
            self.manager.actualizar_progreso(
                job_id,
                estado=evento.estado,
                indice_paso=evento.indice_paso,
                paso_actual=evento.paso_actual,
                porcentaje=evento.porcentaje,
                mensaje=evento.mensaje,
                error=evento.error,
            )

        return reportar

    def ejecutar_job(self, job_id: str) -> ResultadoPipeline:
        """Ejecuta el pipeline de un Job de forma **síncrona** (para el executor).

        Marca el Job en ejecución, ejecuta los cinco pasos, registra el resultado
        en el Gestor y —pase lo que pase— limpia el directorio de trabajo
        (Req 13.4, 13.5).

        Returns:
            El :class:`ResultadoPipeline` del Job.

        Raises:
            KeyError: Si el Job no existe en el Gestor.
        """
        job_state = self.manager.obtener(job_id)
        if job_state is None:
            raise KeyError(f"Job inexistente: {job_id!r}")

        self.manager.marcar_en_ejecucion(job_id)
        job_wd = JobWorkdir(job_id)
        reporter = self._crear_reporter(job_id)
        musica_wav = self.resolver_musica(job_state.musica_id)
        # Clave transitoria de OpenAI para la corrección con IA (spec
        # subtitulos-ia-remotion, Req 2.4, 1.2). Se recupera del Gestor de Jobs
        # (mapa en memoria, fuera de la serialización del Job) y se propaga al
        # pipeline como canal para el sub-paso de IA (integración en la Tarea 4).
        # NUNCA se registra en logs ni se incluye en mensajes de error.
        api_key = self.manager.obtener_api_key(job_id)

        # El ``Orden_de_Clips`` almacenado contiene identificadores de clip; el
        # pipeline (paso UNIR → ``ffprobe``) necesita RUTAS de archivo reales, así
        # que se resuelve cada id a su ruta antes de ejecutar (BUG: se pasaban ids
        # y ``ffprobe`` fallaba con "No such file or directory"). Con el resolutor
        # por defecto (identidad) el comportamiento no cambia para los tests.
        orden_rutas = [self.resolver_clip(cid) for cid in job_state.orden_clips]

        resultado: ResultadoPipeline
        # Cuando el pipeline se pausa para la revisión manual de subtítulos NO se
        # limpia el workdir (los intermedios se necesitan al reanudar la fase 2).
        limpiar = True
        try:
            resultado = ejecutar_pipeline(
                job_wd,
                orden_rutas,
                job_state.ajustes,
                musica_wav=musica_wav,
                api_key=api_key,
                reporter=reporter,
                runner=self.runner,
                **self._inyecciones,
            )
            if resultado.pendiente_edicion_silencios:
                # Pausa por edición manual de silencios (spec edicion-avanzada-shorts,
                # Req 1.2, 1.3, 16.2): tras UNIR, el pipeline detectó los tramos de
                # silencio sobre el vídeo **unido** (sin recortar) y se detuvo a la
                # espera de que el usuario los edite en el timeline y confirme con
                # ``POST /silencios/{id}``. Se persiste el estado
                # ESPERANDO_EDICION_SILENCIOS con los tres artefactos que aporta el
                # ``ResultadoPipeline`` (``unido``, ``silencios``, ``duracion_unido_s``)
                # y NO se limpia el workdir (los intermedios se necesitan para
                # aplicar los tramos y continuar al reanudar, Req 16.2, 16.3).
                self.manager.marcar_esperando_edicion_silencios(
                    job_id,
                    str(resultado.unido) if resultado.unido is not None else "",
                    resultado.silencios if resultado.silencios is not None else [],
                    (
                        float(resultado.duracion_unido_s)
                        if resultado.duracion_unido_s is not None
                        else 0.0
                    ),
                )
                limpiar = False
                return resultado
            if resultado.pendiente_revision:
                # Pausa por revisión manual: guardar grupos + video cortado y
                # dejar el Job a la espera SIN limpiar los temporales.
                self.manager.marcar_esperando_revision(
                    job_id,
                    str(resultado.cortado) if resultado.cortado is not None else "",
                    resultado.grupos,
                )
                limpiar = False
                return resultado
            if resultado.pendiente_eleccion_render:
                # Pausa por edición final (spec edicion-avanzada-shorts, Req 8.1):
                # el pipeline preparó los ``grupos_finales`` y se detuvo SIN
                # renderizar, a la espera de la previsualización + textos extra. Se
                # persiste el estado ESPERANDO_EDICION_FINAL (con el video
                # ``cortado`` y los grupos finales) y NO se limpia el workdir (los
                # intermedios se necesitan al reanudar el render final —SIEMPRE con
                # Remotion— vía POST /render/{id}, Req 16.2, 16.3).
                #
                # NOTA (renombrado): el pipeline sigue señalando esta pausa con el
                # flag ``pendiente_eleccion_render``; ese flag se mapea ahora al
                # marcador ``marcar_esperando_edicion_final`` (antes
                # ``marcar_esperando_eleccion_render``).
                self.manager.marcar_esperando_edicion_final(
                    job_id,
                    str(resultado.cortado) if resultado.cortado is not None else "",
                    resultado.grupos,
                )
                limpiar = False
                return resultado
            if resultado.exito:
                self.manager.marcar_completado(
                    job_id,
                    ruta_video_final=(
                        str(resultado.ruta_video_final)
                        if resultado.ruta_video_final is not None
                        else None
                    ),
                )
            else:
                # El pipeline ya reportó el evento FALLIDO; se refuerza el estado.
                self.manager.marcar_fallido(
                    job_id,
                    resultado.paso_fallido,
                    resultado.motivo or "fallo del pipeline",
                )
        except Exception as exc:  # noqa: BLE001 - fallo inesperado => Job fallido
            logger.exception("Fallo inesperado ejecutando el Job %s", job_id)
            self.manager.marcar_fallido(job_id, "PIPELINE", str(exc))
            resultado = ResultadoPipeline(exito=False, motivo=str(exc))
        finally:
            # Limpieza de temporales en toda terminación (Req 13.4, 13.5), salvo
            # cuando el Job quedó a la espera de la revisión manual.
            if limpiar:
                try:
                    job_wd.cleanup()
                except Exception:  # noqa: BLE001 - la limpieza no debe propagar
                    logger.exception(
                        "Fallo al limpiar el workdir del Job %s", job_id
                    )

        return resultado

    def reanudar_job(self, job_id: str, grupos: Any) -> ResultadoPipeline:
        """Aplica los subtítulos editados y **pausa** en la edición final.

        Reanuda un Job pausado en ``ESPERANDO_REVISION`` (revisión manual de
        subtítulos): toma los ``grupos`` de subtítulo ya editados por el usuario y
        prepara los ``grupos_finales`` con :func:`preparar_grupos_y_pausar`
        (agrupación no aplica —los grupos vienen dados— y la corrección con IA se
        OMITE con ``aplicar_ia=False`` porque los grupos ya vienen aprobados a
        mano por el usuario; si la IA estaba activada, ya se aplicó antes de la
        pausa de revisión). En lugar de renderizar directamente
        (comportamiento previo), el Job vuelve a pausarse en
        ``ESPERANDO_EDICION_FINAL`` a la espera de que el usuario ajuste la
        previsualización y añada los textos extra (spec edicion-avanzada-shorts,
        Req 8.1): el render efectivo —SIEMPRE con Remotion— lo dispara
        ``POST /render/{id}`` (ver :meth:`reanudar_render_job`).

        **NO** limpia el workdir: los intermedios (video ``cortado``) se necesitan
        para el render de la reanudación posterior.

        Args:
            job_id: Identificador del Job pausado en ``ESPERANDO_REVISION``.
            grupos: Grupos de subtítulo editados a aplicar.

        Returns:
            El :class:`ResultadoPipeline` señalizando la pausa de edición final
            (``pendiente_eleccion_render=True``, persistida como
            ``ESPERANDO_EDICION_FINAL``).

        Raises:
            KeyError: Si el Job no existe en el Gestor.
        """
        job_state = self.manager.obtener(job_id)
        if job_state is None:
            raise KeyError(f"Job inexistente: {job_id!r}")

        # Volver a EN_EJECUCION (desde ESPERANDO_REVISION) mientras se preparan
        # los grupos finales.
        self.manager.marcar_en_ejecucion(job_id)
        reporter = self._crear_reporter(job_id)
        cortado = job_state.cortado_path or ""
        # Clave transitoria de OpenAI para la corrección con IA de los grupos
        # editados (Req 2.4). Nunca se registra en logs.
        api_key = self.manager.obtener_api_key(job_id)

        resultado: ResultadoPipeline
        try:
            resultado = preparar_grupos_y_pausar(
                cortado,
                job_state.ajustes,
                palabras=[],
                grupos=grupos,
                api_key=api_key,
                # Al reanudar desde la revisión manual NO se vuelve a pasar la IA
                # sobre los grupos ya aprobados (evita doble corrección): si la IA
                # estaba activada ya se aplicó antes de la pausa; si estaba
                # desactivada era no-op de todos modos.
                aplicar_ia=False,
                reporter=reporter,
            )
            # Persistir la pausa de edición final con los grupos ya definitivos.
            # NO se limpia el workdir (se necesita para el render). El flag del
            # pipeline (``pendiente_eleccion_render``) se mapea al marcador
            # ``marcar_esperando_edicion_final`` (renombrado desde
            # ``marcar_esperando_eleccion_render``).
            self.manager.marcar_esperando_edicion_final(
                job_id,
                str(resultado.cortado) if resultado.cortado is not None else cortado,
                resultado.grupos,
            )
        except Exception as exc:  # noqa: BLE001 - fallo inesperado => Job fallido
            logger.exception(
                "Fallo inesperado al preparar los grupos del Job %s", job_id
            )
            self.manager.marcar_fallido(job_id, "PIPELINE", str(exc))
            resultado = ResultadoPipeline(exito=False, motivo=str(exc))
            # Solo en fallo se limpia el workdir (no habrá render posterior).
            try:
                JobWorkdir(job_id).cleanup()
            except Exception:  # noqa: BLE001 - la limpieza no debe propagar
                logger.exception("Fallo al limpiar el workdir del Job %s", job_id)

        return resultado

    def reanudar_silencios_job(
        self, job_id: str, tramos_editados: Any
    ) -> ResultadoPipeline:
        """Aplica los tramos de silencio editados y continúa hasta la siguiente pausa.

        Reanuda un Job pausado en ``ESPERANDO_EDICION_SILENCIOS`` (edición manual
        de silencios en el timeline, spec edicion-avanzada-shorts, Req 5.1, 5.7):
        toma del :class:`~app.models.job.JobState` los artefactos persistidos en
        la pausa —``unido_path`` (vídeo unido pre-corte) y ``duracion_unido_s``—
        y los ``tramos_editados`` que el usuario confirmó con
        ``POST /silencios/{id}`` (tarea 5.1), y delega en
        :func:`~app.engine.pipeline.reanudar_desde_silencios`, que reconstruye el
        vídeo **cortado** aplicando el complemento de los tramos a borrar y
        continúa el flujo secuencial TRANSCRIBIR → SUBTÍTULOS → (revisión) →
        edición final, **sin regenerar** los artefactos ya completados (UNIR y la
        detección de silencios, Req 16.1, 16.3).

        El resultado señaliza la **siguiente** pausa (revisión manual de
        subtítulos o edición final), que se persiste igual que en
        :meth:`ejecutar_job`, o bien un fallo. En cualquier pausa NO se limpia el
        workdir (los intermedios se necesitan para reanudar, Req 16.2); solo se
        limpia ante un fallo.

        **Interfaz para el endpoint POST /silencios/{id} (tarea 5.1):** el
        endpoint invocará :meth:`lanzar_reanudacion_silencios` (o esta misma
        función en modo síncrono) pasando ``job_id`` y la lista de tramos a
        BORRAR ``[(inicio_s, fin_s), ...]`` ya validados. El runner obtiene el
        resto (``unido_path``, ``duracion_unido_s``) del ``JobState``; el endpoint
        NO necesita reenviarlos.

        Args:
            job_id: Identificador del Job pausado en ``ESPERANDO_EDICION_SILENCIOS``.
            tramos_editados: Tramos a BORRAR ``(inicio_s, fin_s)`` confirmados por
                el usuario (posiblemente vacíos → no se borra nada, Req 1.4/5.5).

        Returns:
            El :class:`ResultadoPipeline` señalizando la siguiente pausa o un fallo.

        Raises:
            KeyError: Si el Job no existe en el Gestor.
        """
        job_state = self.manager.obtener(job_id)
        if job_state is None:
            raise KeyError(f"Job inexistente: {job_id!r}")

        # Volver a EN_EJECUCION (desde ESPERANDO_EDICION_SILENCIOS) mientras se
        # aplica el corte y se continúa el pipeline.
        self.manager.marcar_en_ejecucion(job_id)
        job_wd = JobWorkdir(job_id)
        reporter = self._crear_reporter(job_id)
        # Clave transitoria de OpenAI para el sub-paso de IA posterior (Req 2.4).
        # Nunca se registra en logs.
        api_key = self.manager.obtener_api_key(job_id)
        # Artefactos persistidos durante la pausa de silencios (tarea 4.3):
        unido = job_state.unido_path or ""
        duracion = (
            float(job_state.duracion_unido_s)
            if job_state.duracion_unido_s is not None
            else 0.0
        )

        # Por defecto NO se limpia el workdir: la reanudación termina en otra
        # pausa (revisión/edición final) cuyos intermedios se necesitan (Req 16.2).
        limpiar = False
        resultado: ResultadoPipeline
        try:
            resultado = reanudar_desde_silencios(
                job_wd,
                unido,
                list(tramos_editados) if tramos_editados is not None else [],
                duracion,
                job_state.ajustes,
                api_key=api_key,
                reporter=reporter,
                runner=self.runner,
                **self._inyecciones,
            )
            if resultado.pendiente_revision:
                # Pausa por revisión manual de subtítulos: persistir grupos +
                # vídeo cortado SIN limpiar el workdir.
                self.manager.marcar_esperando_revision(
                    job_id,
                    str(resultado.cortado) if resultado.cortado is not None else "",
                    resultado.grupos,
                )
                return resultado
            if resultado.pendiente_eleccion_render:
                # Pausa por edición final: persistir grupos finales + vídeo
                # cortado SIN limpiar el workdir. El flag del pipeline
                # ``pendiente_eleccion_render`` se mapea a
                # ``marcar_esperando_edicion_final`` (Req 8.1, 16.2).
                self.manager.marcar_esperando_edicion_final(
                    job_id,
                    str(resultado.cortado) if resultado.cortado is not None else "",
                    resultado.grupos,
                )
                return resultado
            # No debería ocurrir en el flujo normal (la reanudación siempre acaba
            # en una pausa), pero por robustez se contempla un fallo del corte: se
            # refuerza el estado FALLIDO y se limpia el workdir.
            self.manager.marcar_fallido(
                job_id,
                resultado.paso_fallido,
                resultado.motivo or "fallo del pipeline",
            )
            limpiar = True
        except Exception as exc:  # noqa: BLE001 - fallo inesperado => Job fallido
            logger.exception(
                "Fallo inesperado al reanudar los silencios del Job %s", job_id
            )
            self.manager.marcar_fallido(job_id, "PIPELINE", str(exc))
            resultado = ResultadoPipeline(exito=False, motivo=str(exc))
            limpiar = True
        finally:
            # Solo se limpia el workdir ante fallo (en las pausas se conserva para
            # poder reanudar, Req 16.2, 16.3).
            if limpiar:
                try:
                    job_wd.cleanup()
                except Exception:  # noqa: BLE001 - la limpieza no debe propagar
                    logger.exception(
                        "Fallo al limpiar el workdir del Job %s", job_id
                    )

        return resultado

    def reanudar_render_job(
        self, job_id: str, motor: MotorRender = MOTOR_RENDER_EDICION_FINAL
    ) -> ResultadoPipeline:
        """Reanuda la **fase 2** (render) tras la edición final (Req 7.1, 10.1).

        Reanuda un Job pausado en ``ESPERANDO_EDICION_FINAL`` ejecutando
        :func:`reanudar_pipeline` sobre el video ``cortado`` y los
        ``grupos_finales`` guardados durante la pausa. En el flujo de edición
        avanzada de shorts el render es **SIEMPRE con Remotion** (spec
        edicion-avanzada-shorts, Req 7.1, 11.2, 11.6), por lo que ``motor`` es
        ``"remotion"`` por defecto (:data:`MOTOR_RENDER_EDICION_FINAL`); el
        parámetro se conserva por compatibilidad con el endpoint. Se propagan los
        ``textos_extra`` persistidos en el ``JobState`` (por
        :meth:`~app.jobs.manager.JobManager.guardar_textos_extra` desde
        ``POST /render/{id}``, Req 10.1) al render Remotion, que
        :func:`reanudar_pipeline` reenvía al constructor de props para emitir los
        overlays ``textosExtra`` (Req 10.2). Renderiza los subtítulos, mezcla
        música (si la hay) y conserva el ``Video_Final``. El progreso se reporta
        de forma monótona en el rango 70–90 % del paso SUBTITULOS. Al terminar
        —éxito o error— limpia el workdir: si el render falla, el Job pasa a
        ``FALLIDO`` con error accionable (sin fallback a otro motor, Req 7.4).

        Args:
            job_id: Identificador del Job pausado en ``ESPERANDO_EDICION_FINAL``.
            motor: Motor de render (``"remotion"`` por defecto; ``"ass"`` se
                mantiene por compatibilidad pero no se usa en este flujo).

        Returns:
            El :class:`ResultadoPipeline` de la fase 2 (render).

        Raises:
            KeyError: Si el Job no existe en el Gestor.
        """
        job_state = self.manager.obtener(job_id)
        if job_state is None:
            raise KeyError(f"Job inexistente: {job_id!r}")

        # Volver a EN_EJECUCION (desde ESPERANDO_EDICION_FINAL) para el render.
        self.manager.marcar_en_ejecucion(job_id)
        job_wd = JobWorkdir(job_id)
        reporter = self._crear_reporter(job_id)
        musica_wav = self.resolver_musica(job_state.musica_id)
        cortado = job_state.cortado_path or ""
        grupos = job_state.grupos_finales or []
        # Textos extra tipo "hook" persistidos en la edición final (Req 10.1): se
        # propagan al render Remotion para emitir los overlays ``textosExtra``
        # (Req 10.2). Lista vacía si el usuario no añadió ninguno.
        textos_extra = job_state.textos_extra or []

        resultado: ResultadoPipeline
        try:
            resultado = reanudar_pipeline(
                job_wd,
                cortado,
                job_state.ajustes,
                palabras=[],
                grupos=grupos,
                textos_extra=textos_extra,
                motor=motor,
                musica_wav=musica_wav,
                reporter=reporter,
                runner=self.runner,
                **self._inyecciones,
            )
            if resultado.exito:
                self.manager.marcar_completado(
                    job_id,
                    ruta_video_final=(
                        str(resultado.ruta_video_final)
                        if resultado.ruta_video_final is not None
                        else None
                    ),
                )
            else:
                self.manager.marcar_fallido(
                    job_id,
                    resultado.paso_fallido,
                    resultado.motivo or "fallo del pipeline",
                )
        except Exception as exc:  # noqa: BLE001 - fallo inesperado => Job fallido
            logger.exception(
                "Fallo inesperado al reanudar el render del Job %s", job_id
            )
            self.manager.marcar_fallido(job_id, "PIPELINE", str(exc))
            resultado = ResultadoPipeline(exito=False, motivo=str(exc))
        finally:
            try:
                job_wd.cleanup()
            except Exception:  # noqa: BLE001 - la limpieza no debe propagar
                logger.exception("Fallo al limpiar el workdir del Job %s", job_id)

        return resultado

    async def lanzar(self, job_id: str) -> asyncio.Future:
        """Lanza la ejecución del Job en background sin bloquear (Req 10.1).

        Programa :meth:`ejecutar_job` en el executor por defecto del bucle de
        eventos y devuelve inmediatamente el :class:`asyncio.Future` asociado, de
        modo que ``POST /procesar`` pueda responder el ``job_id`` en <= 2 s.

        Returns:
            El ``Future`` de la ejecución en background (no se espera aquí).
        """
        loop = asyncio.get_event_loop()
        return loop.run_in_executor(None, self.ejecutar_job, job_id)

    async def lanzar_reanudacion(self, job_id: str, grupos: Any) -> asyncio.Future:
        """Lanza la reanudación (fase 2) de un Job en background sin bloquear.

        Programa :meth:`reanudar_job` en el executor por defecto y devuelve el
        ``Future`` de inmediato, de modo que ``POST /subtitulos/{id}`` pueda
        responder rápidamente mientras se quema/mezcla en segundo plano.

        Returns:
            El ``Future`` de la ejecución en background (no se espera aquí).
        """
        loop = asyncio.get_event_loop()
        return loop.run_in_executor(None, self.reanudar_job, job_id, grupos)

    async def lanzar_reanudacion_silencios(
        self, job_id: str, tramos_editados: Any
    ) -> asyncio.Future:
        """Lanza la reanudación desde silencios en background sin bloquear (Req 5.1, 5.7).

        Programa :meth:`reanudar_silencios_job` en el executor por defecto del
        bucle de eventos y devuelve de inmediato el ``Future`` asociado, de modo
        que el endpoint ``POST /silencios/{id}`` (tarea 5.1) pueda responder
        ``202`` rápidamente mientras el corte de silencios y el resto del flujo
        (TRANSCRIBIR → SUBTÍTULOS → ...) se ejecutan en segundo plano.

        Esta es la función que invocará el endpoint 5.1 pasando ``job_id`` y la
        lista de tramos a BORRAR ``[(inicio_s, fin_s), ...]`` ya validados; el
        runner obtiene el resto de artefactos (``unido_path``,
        ``duracion_unido_s``) del ``JobState``.

        Returns:
            El ``Future`` de la ejecución en background (no se espera aquí).
        """
        loop = asyncio.get_event_loop()
        return loop.run_in_executor(
            None, self.reanudar_silencios_job, job_id, tramos_editados
        )

    async def lanzar_reanudacion_render(
        self, job_id: str, motor: MotorRender = DEFAULT_MOTOR_RENDER
    ) -> asyncio.Future:
        """Lanza el render (fase 2) con el motor elegido en background sin bloquear.

        Programa :meth:`reanudar_render_job` en el executor por defecto y devuelve
        el ``Future`` de inmediato, de modo que ``POST /render/{id}`` pueda
        responder ``202`` rápidamente mientras el render corre en segundo plano
        (spec subtitulos-ia-remotion, Req 6.3, 8.1).

        Returns:
            El ``Future`` de la ejecución en background (no se espera aquí).
        """
        loop = asyncio.get_event_loop()
        return loop.run_in_executor(
            None, self.reanudar_render_job, job_id, motor
        )


__all__ = ["JobRunner", "ResolverMusica", "ResolverClip"]
