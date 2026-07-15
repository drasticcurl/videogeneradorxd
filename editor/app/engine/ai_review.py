"""Sub-paso 4b del pipeline — Corrección de subtítulos con IA (OpenAI), opt-in.

Este módulo corrige el texto de los :class:`~app.models.settings.GrupoSubtitulo`
mediante un modelo de OpenAI (por defecto ``gpt-4.1-mini``), **preservando los
tiempos por grupo** (``inicio_s``/``fin_s``) y las ``palabras``: la IA solo edita
el campo ``texto``. Es la **única** parte del sistema que abre conexiones de red
externas (HTTPS a ``api.openai.com``) y, por ello, es estrictamente opt-in
(Req 12.2).

Principio rector — **degradación con gracia** (Req 5): la corrección con IA
nunca puede tumbar el pipeline. Ante ausencia de clave, IA desactivada, error de
red/HTTP/timeout, respuesta malformada o cardinalidad inválida, la función
**devuelve los grupos originales** (identidad) sin propagar la excepción.

El cliente de OpenAI es **inyectable** (protocolo :class:`OpenAIClienteProto`)
para que los tests verifiquen el comportamiento sin acceder a la red. Cuando no
se inyecta cliente, se usa el SDK oficial ``openai`` de forma diferida, aislado
tras el protocolo (el módulo importa correctamente aunque ``openai`` no esté
instalado; solo se necesita al ejecutar realmente la corrección).

Referencias de requisitos: 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 4.4, 5.1, 5.2,
5.4, 5.5, 12.2.
"""

from __future__ import annotations

import json
import logging
from typing import List, Optional, Sequence

try:  # Protocol está en typing desde Python 3.8.
    from typing import Protocol, runtime_checkable
except ImportError:  # pragma: no cover - compatibilidad defensiva
    from typing_extensions import Protocol, runtime_checkable  # type: ignore

from app.models.settings import AjustesRevisionIA, GrupoSubtitulo

logger = logging.getLogger(__name__)

# Claves de objeto JSON que se aceptan como contenedor del array de líneas cuando
# el modelo responde con un objeto (modo ``response_format`` JSON) en lugar de un
# array desnudo. Se prueban en este orden antes de recurrir al primer valor lista.
_CLAVES_LISTA: tuple[str, ...] = ("lineas", "textos", "resultado", "correcciones")

# Prompt de sistema (español). Instruye al modelo a corregir SOLO ortografía y
# acentos, conservando el número y el orden de las líneas (Req 4.1, 4.2).
_SYSTEM_BASE: str = (
    "Eres un corrector ortográfico de subtítulos en español. Corrige únicamente "
    "la ortografía y los acentos del texto de cada línea. NO cambies el "
    "significado, NO fusiones ni dividas líneas, NO añadas ni elimines líneas y "
    "NO añadas puntuación nueva innecesaria. Conserva EXACTAMENTE el número y el "
    'orden de las líneas de la entrada. Devuelve un objeto JSON con una única '
    'clave "lineas" cuyo valor sea un array de cadenas con la MISMA cantidad de '
    "elementos que la entrada y en el mismo orden."
)

# Instrucción adicional cuando se solicita forzar minúsculas (Req 4.3).
_SYSTEM_MINUSCULAS: str = (
    " Devuelve además todo el texto corregido en minúsculas."
)


@runtime_checkable
class OpenAIClienteProto(Protocol):
    """Protocolo del cliente de OpenAI inyectable en :func:`corregir_grupos_ia`.

    Aísla el SDK real tras una única operación: pedir la corrección de una lista
    de textos y devolver el **contenido JSON en crudo** de la respuesta del
    modelo (una cadena). Esto permite a los tests inyectar dobles que devuelven
    respuestas arbitrarias o lanzan errores sin depender de la red.

    Contrato de errores:
        * Debe lanzar :class:`LimiteTasaError` cuando OpenAI responde con código
          429 (para activar la política de reintentos).
        * Cualquier otra excepción (red, HTTP, timeout) se traduce en
          degradación a identidad por parte de :func:`corregir_grupos_ia`.
    """

    def crear_correccion(
        self,
        *,
        modelo: str,
        system: str,
        contenido_usuario: str,
        timeout_s: float,
    ) -> str:
        """Solicita la corrección y devuelve el contenido JSON en crudo."""
        ...


class RevisionIAError(Exception):
    """Fallo irrecuperable de la revisión IA (solo para validación previa).

    En el flujo normal la corrección con IA **degrada con gracia** y no propaga
    excepciones; esta clase se reserva para condiciones de configuración
    inválidas detectables a priori que un llamador quiera señalar explícitamente.
    """


class LimiteTasaError(RevisionIAError):
    """El cliente de OpenAI señaló un límite de tasa (código 429).

    Un cliente (real o doble) la lanza para que :func:`corregir_grupos_ia`
    reintente hasta ``max_reintentos`` veces antes de degradar (Req 5.5).
    """


class _FormatoRespuestaError(RevisionIAError):
    """La respuesta del modelo no tiene la forma esperada (array de cadenas)."""


def _copia_identidad(grupos: Sequence[GrupoSubtitulo]) -> List[GrupoSubtitulo]:
    """Devuelve una copia profunda de ``grupos`` (degradación = identidad).

    Se copia en profundidad para tratar la entrada como **inmutable** (Req 3.4):
    el resultado no comparte referencias con los grupos de entrada.
    """
    return [g.model_copy(deep=True) for g in grupos]


def _extraer_lista(datos: object) -> Optional[list]:
    """Extrae el array de líneas de la estructura JSON deserializada.

    Acepta tanto un array desnudo (``[...]``) como un objeto que contenga el
    array bajo una de las claves conocidas o, en su defecto, bajo el primer valor
    de tipo lista. Devuelve ``None`` si no encuentra ninguna lista.
    """
    if isinstance(datos, list):
        return datos
    if isinstance(datos, dict):
        for clave in _CLAVES_LISTA:
            valor = datos.get(clave)
            if isinstance(valor, list):
                return valor
        for valor in datos.values():
            if isinstance(valor, list):
                return valor
    return None


def _parsear_textos(contenido: str) -> List[str]:
    """Parsea el contenido JSON del modelo a una lista de cadenas.

    Raises:
        _FormatoRespuestaError: Si el JSON no es válido o no representa una lista
            de cadenas (forma inválida ⇒ degradación a identidad).
    """
    try:
        datos = json.loads(contenido)
    except (ValueError, TypeError) as exc:
        raise _FormatoRespuestaError("respuesta JSON no parseable") from exc

    lista = _extraer_lista(datos)
    if lista is None or not all(isinstance(x, str) for x in lista):
        raise _FormatoRespuestaError("la respuesta no es una lista de cadenas")
    return list(lista)


def _construir_system(minusculas: bool) -> str:
    """Construye el prompt de sistema, añadiendo la instrucción de minúsculas."""
    return _SYSTEM_BASE + (_SYSTEM_MINUSCULAS if minusculas else "")


def _construir_contenido_usuario(textos: Sequence[str]) -> str:
    """Serializa los textos de entrada como array JSON para el mensaje de usuario."""
    return json.dumps(list(textos), ensure_ascii=False)


class _ClienteOpenAI:
    """Adaptador por defecto sobre el SDK oficial ``openai`` (aislado del núcleo).

    Importa ``openai`` de forma diferida para no exigir la biblioteca al importar
    este módulo. Traduce el error de límite de tasa (429) del SDK a
    :class:`LimiteTasaError`; el resto de errores se propagan tal cual y provocan
    la degradación a identidad.
    """

    def __init__(self, api_key: str) -> None:
        from openai import OpenAI  # import diferido (aísla la dependencia)

        self._cliente = OpenAI(api_key=api_key)

    def crear_correccion(
        self,
        *,
        modelo: str,
        system: str,
        contenido_usuario: str,
        timeout_s: float,
    ) -> str:
        try:
            respuesta = self._cliente.chat.completions.create(
                model=modelo,
                timeout=timeout_s,
                response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": contenido_usuario},
                ],
            )
        except Exception as exc:  # noqa: BLE001 - se clasifica el 429 y se repropaga
            if _es_error_limite_tasa(exc):
                raise LimiteTasaError(str(exc)) from exc
            raise
        # Extrae el contenido textual del primer mensaje de la respuesta.
        try:
            contenido = respuesta.choices[0].message.content
        except (AttributeError, IndexError, KeyError) as exc:
            raise _FormatoRespuestaError("respuesta de OpenAI sin contenido") from exc
        return contenido or ""


def _es_error_limite_tasa(exc: BaseException) -> bool:
    """Indica si ``exc`` corresponde a un límite de tasa (código 429) de OpenAI.

    Se detecta sin depender de importar clases concretas del SDK: por el atributo
    ``status_code``/``code`` (429) o por el nombre de la clase de la excepción.
    """
    if getattr(exc, "status_code", None) == 429:
        return True
    if str(getattr(exc, "code", "")) == "429":
        return True
    return "ratelimit" in type(exc).__name__.lower()


def _crear_cliente_por_defecto(api_key: str) -> OpenAIClienteProto:
    """Crea el cliente por defecto basado en el SDK oficial ``openai``."""
    return _ClienteOpenAI(api_key)


def _llamar_con_reintentos(
    cliente: OpenAIClienteProto,
    *,
    modelo: str,
    system: str,
    contenido_usuario: str,
    timeout_s: float,
    max_reintentos: int,
) -> str:
    """Invoca al cliente reintentando ante 429 hasta ``max_reintentos`` veces.

    Raises:
        LimiteTasaError: Si se agotan los reintentos y persiste el 429.
        Exception: Cualquier otro error del cliente se propaga sin reintentar.
    """
    try:
        reintentos = max(0, int(max_reintentos))
    except (TypeError, ValueError):
        reintentos = 0
    intentos_totales = reintentos + 1

    for numero in range(intentos_totales):
        try:
            return cliente.crear_correccion(
                modelo=modelo,
                system=system,
                contenido_usuario=contenido_usuario,
                timeout_s=timeout_s,
            )
        except LimiteTasaError:
            if numero >= intentos_totales - 1:
                raise
            # Advertencia sin incluir la clave de API (Req 5.4, 12.2).
            logger.warning(
                "Revisión IA: límite de tasa (429); reintento %d de %d",
                numero + 1,
                reintentos,
            )
    # Inalcanzable: el bucle siempre retorna o relanza en la última iteración.
    raise LimiteTasaError("se agotaron los reintentos")  # pragma: no cover


def corregir_grupos_ia(
    grupos: Sequence[GrupoSubtitulo],
    ajustes: AjustesRevisionIA,
    api_key: Optional[str],
    *,
    cliente: Optional[OpenAIClienteProto] = None,
    minusculas: bool = False,
) -> List[GrupoSubtitulo]:
    """Corrige el texto de ``grupos`` con IA preservando los tiempos (Req 3, 4, 5).

    Comportamiento:

    * **Degradación temprana** (Req 5.1): si ``grupos`` está vacío, la IA está
      desactivada (``ajustes.activado`` es ``False``) o ``api_key`` es falsy,
      devuelve una copia identidad de ``grupos`` sin invocar a OpenAI.
    * Construye el prompt (system en español; salida estructurada JSON) y empareja
      los textos corregidos por índice (Req 4.1, 4.2).
    * **Preservación de tiempos** (Req 3.1, 3.2, 3.3): el resultado tiene la misma
      cardinalidad y conserva ``inicio_s``/``fin_s``/``palabras`` de cada grupo;
      solo puede cambiar ``texto``.
    * **No pérdida de líneas** (Req 4.4): si un texto corregido queda vacío, se
      conserva el original de ese índice.
    * **Degradación con gracia** (Req 5.2, 5.4): ante error de red/HTTP/timeout,
      respuesta malformada o cardinalidad inválida, devuelve los grupos
      originales y registra una advertencia **sin** incluir la clave.
    * **Reintentos ante 429** (Req 5.5): reintenta hasta ``ajustes.max_reintentos``
      veces antes de degradar.
    * **Sin efectos secundarios** (Req 3.4): trata ``grupos`` como inmutable, no
      escribe en disco y no registra la ``api_key`` (Req 12.2).

    Args:
        grupos: Grupos de subtítulo de entrada (posiblemente vacío).
        ajustes: Ajustes de la revisión IA (``activado``, ``modelo``, ``timeout_s``,
            ``max_reintentos``).
        api_key: Clave de API de OpenAI transitoria (``None``/vacía ⇒ identidad).
        cliente: Cliente inyectable (protocolo). Si es ``None`` se usa el SDK
            oficial ``openai``.
        minusculas: Si es ``True``, el texto corregido se devuelve en minúsculas.

    Returns:
        Lista de :class:`~app.models.settings.GrupoSubtitulo` de igual cardinalidad
        que ``grupos``, con los tiempos intactos y el texto corregido (o el
        original ante degradación).
    """
    grupos_lista: List[GrupoSubtitulo] = list(grupos)

    # (1) Degradación temprana: nada que corregir o IA no habilitada/sin clave.
    if not grupos_lista or not ajustes.activado or not api_key:
        return _copia_identidad(grupos_lista)

    textos_entrada = [g.texto for g in grupos_lista]

    # (2) Llamada a OpenAI + parseo, todo bajo degradación con gracia.
    try:
        if cliente is None:
            cliente = _crear_cliente_por_defecto(api_key)
        system = _construir_system(minusculas)
        contenido_usuario = _construir_contenido_usuario(textos_entrada)
        contenido = _llamar_con_reintentos(
            cliente,
            modelo=ajustes.modelo,
            system=system,
            contenido_usuario=contenido_usuario,
            timeout_s=ajustes.timeout_s,
            max_reintentos=ajustes.max_reintentos,
        )
        textos_corregidos = _parsear_textos(contenido)
    except Exception as exc:  # noqa: BLE001 - degradación con gracia (Req 5.2)
        # Advertencia SIN la clave (Req 5.4, 12.2): solo el tipo de error.
        logger.warning("Revisión IA degradada: %s", type(exc).__name__)
        return _copia_identidad(grupos_lista)

    # (3) Emparejamiento estricto por índice; la cardinalidad debe coincidir.
    if len(textos_corregidos) != len(grupos_lista):
        logger.warning(
            "Revisión IA: cardinalidad inválida (%d vs %d); se conserva el original",
            len(textos_corregidos),
            len(grupos_lista),
        )
        return _copia_identidad(grupos_lista)

    # (4) Construcción del resultado: solo cambia ``texto`` (Req 3.3, 4.3, 4.4).
    resultado: List[GrupoSubtitulo] = []
    for i, grupo in enumerate(grupos_lista):
        texto = textos_corregidos[i].strip()
        if minusculas:
            texto = texto.lower()
        # Req 4.4: no perder líneas; si queda vacío, conservar el original.
        if not texto:
            texto = grupo.texto
        # Copia profunda con solo el texto actualizado: tiempos y palabras
        # intactos (Req 3.1, 3.2) y sin mutar la entrada (Req 3.4).
        resultado.append(grupo.model_copy(deep=True, update={"texto": texto}))

    # Log informativo de éxito: la IA corrió y emparejó correctamente por índice.
    # NUNCA se registra la ``api_key`` (Req 5.4, 12.2), solo el recuento y el modelo.
    logger.info(
        "Revisión IA: %d grupos corregidos con el modelo %s",
        len(grupos_lista),
        ajustes.modelo,
    )

    return resultado


__all__ = [
    "OpenAIClienteProto",
    "RevisionIAError",
    "LimiteTasaError",
    "corregir_grupos_ia",
]
