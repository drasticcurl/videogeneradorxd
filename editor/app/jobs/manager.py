"""Gestor de Jobs en memoria (Tarea 12.2, Req 10.3, 10.5).

Mantiene el registro de Jobs (``job_id -> JobState``) protegido por un lock, con:

* **Transiciones de estado** en el ciclo de vida del Job:
  ``EN_COLA -> EN_EJECUCION -> COMPLETADO | FALLIDO`` (Req 10.3).
* **Progreso como fuente de verdad** consultada por ``GET /progreso`` (Req 10.5),
  con porcentaje en ``0..100`` **monótono no decreciente** y el índice de paso
  también monótono no decreciente: cualquier actualización que intentara
  retroceder el porcentaje o el índice se **ignora** para ese campo (se conserva
  el valor máximo alcanzado). Esto garantiza la Propiedad 22 (invariantes de
  progreso) y los requisitos de progreso de la feature edicion-avanzada-shorts:
  el porcentaje se mantiene acotado en ``[0, 100]`` y no decrece nunca (Req 16.4)
  y se fija en ``100`` al finalizar con éxito en :meth:`JobManager.marcar_completado`
  (Req 16.5).

Concurrencia: el registro se protege con un :class:`threading.RLock`, correcto
tanto para la capa API asíncrona como para el ejecutor en background (que corre
el pipeline en un hilo del executor). Todas las operaciones que leen o mutan el
estado adquieren el lock.

Referencias de requisitos: 10.3, 10.5, 16.4, 16.5 (y feature edicion-avanzada-shorts
Req 1.3, 8.1, 11.2 para las pausas de edición de silencios y edición final).
"""

from __future__ import annotations

import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from app.models.job import JobState, JobStatus, PipelineStep, Progress
from app.models.settings import Ajustes, TramoSilencio

# Conjunto de estados terminales del ciclo de vida de un Job.
ESTADOS_TERMINALES = frozenset({JobStatus.COMPLETADO, JobStatus.FALLIDO})


def _ahora() -> datetime:
    return datetime.now(timezone.utc)


def _coaccionar_tramo_silencio(t: object) -> TramoSilencio:
    """Coacciona un elemento de silencio a :class:`TramoSilencio`.

    El pipeline (``detectar_silencios`` -> ``ejecutar_pipeline`` -> runner)
    entrega los tramos como TUPLAS ``(inicio_s, fin_s)`` de ``float``, no como
    instancias :class:`TramoSilencio`. Como Pydantic v2 NO coacciona en la
    asignación por atributo, guardar esas tuplas tal cual dejaría
    ``JobState.silencios_detectados`` incumpliendo su tipo declarado
    (``List[TramoSilencio]``) y haría fallar ``GET /silencios/{id}`` al invocar
    ``t.model_dump()`` sobre una tupla.

    Esta función normaliza ambos casos y es idempotente:

    * Si ``t`` ya es un :class:`TramoSilencio`, se devuelve tal cual.
    * Si ``t`` es una tupla/lista ``(inicio, fin)``, se construye el
      :class:`TramoSilencio` correspondiente convirtiendo a ``float``.
    """
    if isinstance(t, TramoSilencio):
        return t
    if isinstance(t, (tuple, list)) and len(t) >= 2:
        return TramoSilencio(inicio_s=float(t[0]), fin_s=float(t[1]))
    # Último recurso: dejar que Pydantic valide/rechace (p. ej. un dict).
    return TramoSilencio.model_validate(t)


class JobManager:
    """Registro de Jobs en memoria con transiciones y progreso monótono.

    El Gestor es la única fuente de verdad del estado y el progreso de cada Job.
    """

    def __init__(self) -> None:
        self._jobs: Dict[str, JobState] = {}
        # Claves de API de OpenAI transitorias por Job (spec subtitulos-ia-remotion,
        # Req 2.3, 2.4). Se guardan en un mapa APARTE del ``JobState`` a propósito:
        # así la clave NUNCA forma parte del modelo del Job ni de su ``model_dump``
        # (no se serializa a disco, no aparece en ``GET /progreso`` ni en logs). Se
        # elimina de este mapa cuando el Job alcanza un estado terminal (Req 2.5).
        self._api_keys: Dict[str, str] = {}
        self._lock = threading.RLock()

    # ------------------------------------------------------------------
    # Registro
    # ------------------------------------------------------------------
    def crear_job(
        self,
        job_id: str,
        orden_clips: List[str],
        ajustes: Ajustes,
        workdir: str,
        *,
        musica_id: Optional[str] = None,
        openai_api_key: Optional[str] = None,
    ) -> JobState:
        """Registra un nuevo Job en estado ``EN_COLA`` (Req 10.3).

        La ``openai_api_key`` (opcional, spec subtitulos-ia-remotion, Req 2.2,
        2.3) es la clave transitoria de OpenAI para la corrección con IA. Se
        almacena en un mapa EN MEMORIA separado del ``JobState`` (:meth:`obtener_api_key`),
        de modo que **nunca** se serialice con el Job ni se persista en disco; se
        elimina al alcanzar un estado terminal (Req 2.5). Si es falsy no se guarda.

        Raises:
            ValueError: Si ya existe un Job con ese ``job_id``.
        """
        with self._lock:
            if job_id in self._jobs:
                raise ValueError(f"Ya existe un Job con id {job_id!r}")
            estado = JobState(
                id=job_id,
                orden_clips=list(orden_clips),
                musica_id=musica_id,
                ajustes=ajustes,
                workdir=workdir,
                progreso=Progress(estado=JobStatus.EN_COLA),
            )
            self._jobs[job_id] = estado
            # La clave se guarda FUERA del JobState (mapa aparte) y solo si viene
            # informada; así no contamina la serialización del Job (Req 2.4).
            if openai_api_key:
                self._api_keys[job_id] = openai_api_key
            return estado

    # ------------------------------------------------------------------
    # Clave de API transitoria (fuera de la serialización del Job)
    # ------------------------------------------------------------------
    def obtener_api_key(self, job_id: str) -> Optional[str]:
        """Devuelve la clave transitoria de OpenAI del Job, o ``None``.

        La lee el :class:`~app.jobs.runner.JobRunner` al ejecutar el pipeline
        para pasársela a la corrección con IA (Req 2.4). Nunca debe registrarse
        en logs ni exponerse en respuestas de la API.
        """
        with self._lock:
            return self._api_keys.get(job_id)

    def _eliminar_api_key(self, job_id: str) -> None:
        """Elimina de memoria la clave transitoria del Job (Req 2.5).

        Debe invocarse dentro del lock. Es idempotente: si no había clave, no
        hace nada.
        """
        self._api_keys.pop(job_id, None)

    def existe(self, job_id: str) -> bool:
        """Indica si hay un Job registrado con ``job_id``."""
        with self._lock:
            return job_id in self._jobs

    def obtener(self, job_id: str) -> Optional[JobState]:
        """Devuelve el :class:`JobState` de ``job_id`` o ``None`` si no existe."""
        with self._lock:
            return self._jobs.get(job_id)

    def listar_ids(self) -> List[str]:
        """Devuelve la lista de identificadores de Jobs registrados."""
        with self._lock:
            return list(self._jobs.keys())

    # ------------------------------------------------------------------
    # Transiciones de estado
    # ------------------------------------------------------------------
    def marcar_en_ejecucion(self, job_id: str) -> JobState:
        """Transición ``EN_COLA -> EN_EJECUCION`` (Req 10.3)."""
        with self._lock:
            job = self._exigir(job_id)
            job.progreso.estado = JobStatus.EN_EJECUCION
            job.actualizado_en = _ahora()
            return job

    def marcar_esperando_revision(
        self,
        job_id: str,
        cortado_path: str,
        grupos: object,
    ) -> JobState:
        """Pausa el Job en ``ESPERANDO_REVISION`` para la revisión manual de subtítulos.

        Almacena la ruta del video ``cortado`` (sobre el que se quemarán los
        subtítulos al reanudar) y los ``grupos`` de subtítulo propuestos para
        editar. El porcentaje/índice de paso alcanzados se conservan (la fase 2
        del pipeline los continuará), respetando la monotonicidad (Req 10.5).
        """
        with self._lock:
            job = self._exigir(job_id)
            job.cortado_path = cortado_path
            job.grupos_subtitulos = list(grupos) if grupos is not None else []
            job.progreso.estado = JobStatus.ESPERANDO_REVISION
            job.progreso.mensaje = "Esperando revisión de subtítulos"
            job.actualizado_en = _ahora()
            return job

    def marcar_esperando_edicion_silencios(
        self,
        job_id: str,
        unido_path: str,
        silencios: object,
        duracion: float,
    ) -> JobState:
        """Pausa el Job en ``ESPERANDO_EDICION_SILENCIOS`` (spec edicion-avanzada-shorts, Req 1.2, 1.3).

        Se invoca cuando el pipeline, tras UNIR los clips, ha detectado los
        tramos de silencio sobre el vídeo **unido** (sin recortar) y queda a la
        espera de que el usuario edite manualmente dichos tramos en el timeline y
        confirme con ``POST /silencios/{id}``. Es una pausa PREVIA a la
        transcripción.

        Persiste en el :class:`JobState` los tres artefactos necesarios para la
        edición y la posterior reanudación (Req 1.3):

        * ``unido_path``: ruta del vídeo unido (pre-corte) que alimenta el
          timeline y sobre el que se aplicarán los tramos a borrar al reanudar.
        * ``silencios_detectados``: lista de :class:`TramoSilencio` detectados (a
          borrar), ya ordenados y sin solapes. Se admite una lista vacía cuando
          no se ha detectado ningún silencio (Req 1.4).
        * ``duracion_unido_s``: duración total del vídeo unido en segundos,
          necesaria para validar/normalizar los tramos y calcular el complemento.

        Análogo a :meth:`marcar_esperando_revision`: el estado es NO terminal,
        por lo que la clave de API transitoria NO se descarta aquí (solo se
        elimina al alcanzar un estado terminal, Req 2.5). El porcentaje/índice de
        paso alcanzados se conservan respetando la monotonicidad (Req 10.5, 16.4).
        """
        with self._lock:
            job = self._exigir(job_id)
            job.unido_path = unido_path
            # COACCIÓN a ``TramoSilencio``: el pipeline entrega los silencios como
            # TUPLAS ``(inicio_s, fin_s)`` y Pydantic v2 no coacciona en asignación
            # por atributo. Normalizamos aquí para que ``silencios_detectados``
            # cumpla siempre su tipo declarado ``List[TramoSilencio]`` y
            # ``GET /silencios/{id}`` pueda serializarlos con ``model_dump()``.
            job.silencios_detectados = (
                [_coaccionar_tramo_silencio(t) for t in silencios]
                if silencios is not None
                else []
            )
            job.duracion_unido_s = duracion
            job.progreso.estado = JobStatus.ESPERANDO_EDICION_SILENCIOS
            job.progreso.mensaje = "Esperando edición manual de silencios"
            job.actualizado_en = _ahora()
            return job

    def marcar_esperando_edicion_final(
        self,
        job_id: str,
        cortado_path: str,
        grupos_finales: object,
    ) -> JobState:
        """Pausa el Job en ``ESPERANDO_EDICION_FINAL`` (spec edicion-avanzada-shorts, Req 8.1).

        Se invoca cuando el pipeline ha preparado los ``grupos_finales`` (grupos
        ya agrupados y corregidos con IA si estaba activada) y queda a la espera
        de que el usuario realice la edición final (previsualización en vivo +
        textos extra) y confirme con ``POST /render/{id}``. El render es SIEMPRE
        con Remotion (ya no hay elección de motor). Almacena la ruta del video
        ``cortado`` (sobre el que se renderizarán los subtítulos al reanudar) y
        los ``grupos_finales`` en su campo DEDICADO del :class:`JobState`.

        NOTA DE COMPATIBILIDAD (renombrado): este marcador sustituye al antiguo
        ``marcar_esperando_eleccion_render`` y transiciona al estado
        ``ESPERANDO_EDICION_FINAL`` (antes ``ESPERANDO_ELECCION_RENDER``). Ocupa
        EXACTAMENTE el mismo punto lógico de pausa del pipeline; solo cambia el
        nombre/semántica (antes "elegir motor"; ahora "preview + textos extra +
        render Remotion").

        Análogo a :meth:`marcar_esperando_revision`: el estado es NO terminal,
        por lo que la clave de API transitoria NO se descarta aquí (solo se
        elimina al alcanzar un estado terminal, Req 2.5). El porcentaje/índice de
        paso alcanzados se conservan respetando la monotonicidad (Req 10.5, 16.4).
        """
        with self._lock:
            job = self._exigir(job_id)
            job.cortado_path = cortado_path
            job.grupos_finales = (
                list(grupos_finales) if grupos_finales is not None else []
            )
            job.progreso.estado = JobStatus.ESPERANDO_EDICION_FINAL
            job.progreso.mensaje = "Esperando edición final (preview + textos extra)"
            job.actualizado_en = _ahora()
            return job

    def guardar_textos_extra(self, job_id: str, textos_extra: object) -> JobState:
        """Persiste en el :class:`JobState` los ``textos_extra`` de la edición final.

        Se invoca al confirmar la edición final (``POST /render/{id}``, spec
        edicion-avanzada-shorts, Req 8.1, 10.1) con la lista de overlays de texto
        plano (máx. 2) que consumirá el constructor de props del render
        (``construir_props``) para emitir el campo ``textosExtra``.

        La lista se copia de forma defensiva. Si es ``None`` se persiste una
        lista vacía (equivalente a "sin textos extra"). No altera el estado ni el
        progreso del Job: es únicamente un setter del artefacto.

        Raises:
            KeyError: Si ``job_id`` no existe.
        """
        with self._lock:
            job = self._exigir(job_id)
            job.textos_extra = list(textos_extra) if textos_extra is not None else []
            job.actualizado_en = _ahora()
            return job

    def marcar_completado(
        self, job_id: str, ruta_video_final: Optional[str] = None
    ) -> JobState:
        """Transición a ``COMPLETADO`` fijando el 100 % (Req 10.3, 10.5)."""
        with self._lock:
            job = self._exigir(job_id)
            job.progreso.estado = JobStatus.COMPLETADO
            job.progreso.porcentaje = 100
            job.progreso.indice_paso = job.progreso.total_pasos
            job.progreso.error = None
            if ruta_video_final is not None:
                job.ruta_video_final = ruta_video_final
            # Estado terminal: descartar la clave transitoria de memoria (Req 2.5).
            self._eliminar_api_key(job_id)
            job.actualizado_en = _ahora()
            return job

    def marcar_fallido(
        self, job_id: str, paso: object, motivo: str
    ) -> JobState:
        """Transición a ``FALLIDO`` exponiendo ``error = {paso, motivo}`` (Req 10.7)."""
        with self._lock:
            job = self._exigir(job_id)
            job.progreso.estado = JobStatus.FALLIDO
            paso_val = paso.value if isinstance(paso, PipelineStep) else str(paso)
            job.progreso.error = {"paso": paso_val, "motivo": motivo}
            # Estado terminal: descartar la clave transitoria de memoria (Req 2.5).
            self._eliminar_api_key(job_id)
            job.actualizado_en = _ahora()
            return job

    # ------------------------------------------------------------------
    # Progreso (fuente de verdad, monótono no decreciente)
    # ------------------------------------------------------------------
    def actualizar_progreso(
        self,
        job_id: str,
        *,
        estado: JobStatus,
        indice_paso: int,
        paso_actual: Optional[PipelineStep],
        porcentaje: int,
        mensaje: str,
        error: Optional[Dict[str, Any]] = None,
    ) -> JobState:
        """Aplica una actualización de progreso preservando la monotonicidad.

        El porcentaje y el índice de paso **nunca retroceden**: se conserva el
        máximo alcanzado (Req 10.5, Propiedad 22). El porcentaje se acota además
        a ``[0, 100]`` de forma defensiva. El estado, el paso actual, el mensaje y
        el error sí se actualizan al último valor reportado.

        Raises:
            KeyError: Si ``job_id`` no existe.
        """
        with self._lock:
            job = self._exigir(job_id)
            prog = job.progreso

            # Acotar a [0, 100] y aplicar monotonicidad no decreciente (Req 10.5).
            pct_acotado = max(0, min(100, int(porcentaje)))
            prog.porcentaje = max(prog.porcentaje, pct_acotado)
            prog.indice_paso = max(prog.indice_paso, int(indice_paso))

            prog.estado = estado
            prog.paso_actual = paso_actual
            prog.mensaje = mensaje
            if error is not None:
                prog.error = error
            elif estado != JobStatus.FALLIDO:
                # Un avance normal no borra un error previo salvo que no lo haya;
                # en la práctica los avances normales no traen error.
                pass

            job.actualizado_en = _ahora()
            return job

    # ------------------------------------------------------------------
    # Utilidades internas
    # ------------------------------------------------------------------
    def _exigir(self, job_id: str) -> JobState:
        job = self._jobs.get(job_id)
        if job is None:
            raise KeyError(f"Job inexistente: {job_id!r}")
        return job


# Instancia compartida por defecto para la aplicación (la capa API la reutiliza).
gestor_jobs = JobManager()


__all__ = ["JobManager", "gestor_jobs", "ESTADOS_TERMINALES"]
