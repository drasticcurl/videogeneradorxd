"""Gestión de Jobs: registro en memoria y ejecución en background (Tarea 12).

Este paquete contiene:

* :mod:`app.jobs.manager` — el Gestor de Jobs en memoria (``job_id -> JobState``)
  con transiciones de estado y progreso monótono no decreciente (Req 10.3, 10.5).
* :mod:`app.jobs.runner` — el ejecutor en background del pipeline y la limpieza
  del directorio de trabajo al finalizar (Req 10.1, 13.4, 13.5).
"""
