"""Tests smoke de arranque y configuración del proyecto (Tarea 21.3).

Estos tests NO ejercen el pipeline ni herramientas externas; verifican que los
artefactos de arranque del proyecto (README, ``requirements.txt``,
``package.json``) están presentes y declaran lo mínimo exigido, y que el backend
opera de forma local y sin autenticación.

Referencias de requisitos:

* **14.1 / 14.2** — El README de la raíz contiene la sección de instalación en
  macOS (``brew install ffmpeg``, entorno virtual + ``pip``, ``npm install``) e
  instrucciones para levantar el backend en ``localhost:8000`` y la Interfaz en
  ``localhost:3000``.
* **14.5** — Un ``requirements.txt`` (raíz y/o backend) declara como mínimo
  ``fastapi``, ``uvicorn``, ``auto-editor``, ``faster-whisper`` y
  ``python-multipart``.
* **14.6** — ``frontend/package.json`` declara las dependencias necesarias para
  ejecutar la Interfaz (``next``, ``react``, ``react-dom``).
* **13.7** — El backend opera sin autenticación: un endpoint como ``/salud``
  responde sin requerir credenciales.
* **13.1** — Operación local sin claves de API ni red externa: el backend no
  requiere variables de entorno de claves de API para importarse ni instanciar
  la app, y está configurado sobre la interfaz de loopback.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

# ---------------------------------------------------------------------------
# Rutas del proyecto resueltas de forma relativa a este archivo de test.
#   este archivo:  <repo>/backend/tests/test_startup.py
#   parents[0] = tests, parents[1] = backend, parents[2] = raíz del repo
# ---------------------------------------------------------------------------
TESTS_DIR = Path(__file__).resolve().parent
BACKEND_DIR = TESTS_DIR.parent
REPO_ROOT = BACKEND_DIR.parent

README_PATH = REPO_ROOT / "README.md"
ROOT_REQUIREMENTS = REPO_ROOT / "requirements.txt"
BACKEND_REQUIREMENTS = BACKEND_DIR / "requirements.txt"
FRONTEND_PACKAGE_JSON = REPO_ROOT / "frontend" / "package.json"

# Dependencias mínimas de Python exigidas por Req 14.5.
DEPENDENCIAS_MINIMAS_PY = (
    "fastapi",
    "uvicorn",
    "auto-editor",
    "faster-whisper",
    "python-multipart",
)

# Dependencias mínimas de frontend para ejecutar la Interfaz (Req 14.6).
DEPENDENCIAS_MINIMAS_FRONT = ("next", "react", "react-dom")


# ---------------------------------------------------------------------------
# README (Req 14.1, 14.2)
# ---------------------------------------------------------------------------
def test_readme_existe_en_la_raiz():
    """El README debe existir en la raíz del proyecto (Req 14.1)."""
    assert README_PATH.is_file(), f"No se encontró el README en {README_PATH}"


def test_readme_menciona_pasos_de_instalacion_macos():
    """El README documenta los tres pasos de instalación en macOS (Req 14.1)."""
    contenido = README_PATH.read_text(encoding="utf-8")
    contenido_lower = contenido.lower()

    # (a) ffmpeg vía Homebrew.
    assert "brew install ffmpeg" in contenido_lower, "Falta `brew install ffmpeg`"
    # (b) entorno virtual + instalación con pip desde requirements.txt.
    assert "venv" in contenido_lower, "Falta la creación de un entorno virtual (venv)"
    assert "pip install -r requirements.txt" in contenido_lower, (
        "Falta la instalación de dependencias de Python con pip"
    )
    # (c) instalación de dependencias del frontend.
    assert "npm install" in contenido_lower, "Falta `npm install` para el frontend"


def test_readme_documenta_los_puertos_de_arranque():
    """El README indica cómo levantar backend (8000) y frontend (3000) (Req 14.2)."""
    contenido = README_PATH.read_text(encoding="utf-8")
    assert "localhost:8000" in contenido, "El README no menciona localhost:8000"
    assert "localhost:3000" in contenido, "El README no menciona localhost:3000"


def test_readme_ordena_los_tres_pasos_de_instalacion():
    """Los tres pasos de instalación aparecen en el orden exigido (Req 14.1).

    Orden requerido: (a) ffmpeg, (b) venv + pip, (c) npm install.
    """
    contenido = README_PATH.read_text(encoding="utf-8").lower()
    idx_ffmpeg = contenido.find("brew install ffmpeg")
    idx_pip = contenido.find("pip install -r requirements.txt")
    idx_npm = contenido.find("npm install")

    assert idx_ffmpeg != -1 and idx_pip != -1 and idx_npm != -1
    assert idx_ffmpeg < idx_pip < idx_npm, (
        "Los pasos de instalación no están en el orden (a) ffmpeg, (b) pip, (c) npm"
    )


# ---------------------------------------------------------------------------
# requirements.txt (Req 14.5)
# ---------------------------------------------------------------------------
def test_existe_requirements_en_raiz_y_backend():
    """Debe existir un requirements.txt en la raíz y en el backend (Req 14.5)."""
    assert ROOT_REQUIREMENTS.is_file(), "Falta requirements.txt en la raíz"
    assert BACKEND_REQUIREMENTS.is_file(), "Falta backend/requirements.txt"


def test_requirements_declara_dependencias_minimas():
    """El conjunto raíz+backend declara las dependencias mínimas (Req 14.5).

    El ``requirements.txt`` de la raíz puede referenciar el del backend
    (``-r backend/requirements.txt``); por eso se considera el contenido
    combinado de ambos archivos.
    """
    combinado = (
        ROOT_REQUIREMENTS.read_text(encoding="utf-8")
        + "\n"
        + BACKEND_REQUIREMENTS.read_text(encoding="utf-8")
    ).lower()

    for dep in DEPENDENCIAS_MINIMAS_PY:
        assert dep in combinado, f"requirements.txt no declara la dependencia mínima: {dep}"


# ---------------------------------------------------------------------------
# frontend/package.json (Req 14.6)
# ---------------------------------------------------------------------------
def test_package_json_declara_dependencias_del_frontend():
    """``frontend/package.json`` declara las dependencias necesarias (Req 14.6)."""
    assert FRONTEND_PACKAGE_JSON.is_file(), "Falta frontend/package.json"

    data = json.loads(FRONTEND_PACKAGE_JSON.read_text(encoding="utf-8"))
    deps = {}
    deps.update(data.get("dependencies", {}))
    deps.update(data.get("devDependencies", {}))

    for dep in DEPENDENCIAS_MINIMAS_FRONT:
        assert dep in deps, f"package.json no declara la dependencia del frontend: {dep}"

    # Debe existir al menos un script de arranque (`dev` o `start`) en el puerto 3000.
    scripts = data.get("scripts", {})
    arranque = " ".join([scripts.get("dev", ""), scripts.get("start", "")])
    assert "3000" in arranque, "package.json no arranca la Interfaz en el puerto 3000"


# ---------------------------------------------------------------------------
# Backend sin autenticación (Req 13.7)
# ---------------------------------------------------------------------------
def test_backend_opera_sin_autenticacion():
    """Un endpoint del backend responde sin requerir credenciales (Req 13.7).

    Se consulta ``/salud`` sin cabecera de autorización ni credenciales; debe
    responder 200. La verificación de dependencias del arranque se sustituye por
    un doble que pasa (el sandbox no tiene ffmpeg/auto-editor/faster-whisper).
    """
    from fastapi.testclient import TestClient

    import main
    from app.deps import checker as _deps_checker

    def _verificacion_ok(*_args, **_kwargs):
        return _deps_checker.ResultadoVerificacion(
            resultados=[
                _deps_checker.ResultadoDependencia(nombre=n, disponible=True)
                for n in _deps_checker.DEPENDENCIAS
            ]
        )

    main.verificar_dependencias = _verificacion_ok  # type: ignore[assignment]

    cliente = TestClient(main.app)
    # Sin cabeceras de autorización: no se envían credenciales de ningún tipo.
    respuesta = cliente.get("/salud")
    assert respuesta.status_code == 200
    assert respuesta.json() == {"estado": "ok"}


def test_ningun_endpoint_declara_esquema_de_seguridad():
    """El esquema OpenAPI no declara ningún requisito de seguridad (Req 13.7)."""
    import main

    esquema = main.app.openapi()
    # No debe haber esquemas de seguridad declarados globalmente.
    componentes = esquema.get("components", {})
    assert not componentes.get("securitySchemes"), (
        "El backend no debe declarar esquemas de seguridad (opera sin auth)"
    )
    # Ninguna operación debe exigir `security`.
    for _ruta, metodos in esquema.get("paths", {}).items():
        for _metodo, operacion in metodos.items():
            if isinstance(operacion, dict):
                assert not operacion.get("security"), (
                    "Ninguna operación debe requerir autenticación"
                )


# ---------------------------------------------------------------------------
# Operación local sin red externa ni claves de API (Req 13.1)
# ---------------------------------------------------------------------------
def test_backend_configurado_sobre_loopback_local():
    """El backend está configurado sobre la interfaz de loopback (Req 13.1)."""
    from app import config

    assert config.BACKEND_HOST in ("127.0.0.1", "localhost", "::1"), (
        f"El backend debe operar localmente, no en {config.BACKEND_HOST}"
    )
    assert config.BACKEND_PORT == 8000
    assert config.FRONTEND_PORT == 3000


def test_backend_no_requiere_claves_de_api_para_importarse():
    """Importar la app no exige variables de entorno de claves de API (Req 13.1).

    Se verifica de forma razonable que el código fuente del backend no **lee**
    variables de entorno con aspecto de clave de API/token de servicio externo,
    ni las embebe como literal en el código: la operación local no depende de
    credenciales del entorno.

    Nota (spec subtitulos-ia-remotion, Req 2.1-2.4, 12.1-12.2): la corrección de
    subtítulos con IA introduce una dependencia externa **opt-in** con OpenAI.
    Su clave es **transitoria**: llega en el cuerpo de ``POST /procesar`` y se
    guarda solo en memoria mientras dura el Job; NUNCA se lee de una variable de
    entorno, ni se hardcodea, ni se persiste. Por eso el guard comprueba que no
    haya **lecturas de env** con nombre de clave (que romperían el modelo local),
    en lugar de prohibir toda mención textual del término (que ahora es legítima
    al nombrar el parámetro transitorio ``openai_api_key``).
    """
    # La importación de la app ya ocurre en otros tests sin API keys definidas;
    # aquí escaneamos el código fuente en busca de LECTURAS de variables de
    # entorno con aspecto de clave de API/token, y de claves embebidas como
    # literal (p. ej. "sk-..."), que sí violarían la operación 100% local.
    nombres_clave = r"(API_KEY|APIKEY|SECRET_KEY|ACCESS_TOKEN|OPENAI|AWS_SECRET|BEARER_TOKEN)"
    # (a) Lectura de una variable de entorno cuyo nombre parece una clave/token.
    patron_lectura_env = re.compile(
        r"(os\.environ|os\.getenv|getenv|environ\.get|environ\.setdefault)"
        r"\s*[\[(]\s*[\"'][^\"']*" + nombres_clave,
        re.IGNORECASE,
    )
    # (b) Clave de OpenAI embebida como literal (formato "sk-...").
    patron_clave_hardcodeada = re.compile(r"[\"']sk-[A-Za-z0-9_\-]{16,}[\"']")

    app_dir = BACKEND_DIR / "app"
    fuentes = list(app_dir.rglob("*.py")) + [BACKEND_DIR / "main.py"]
    ofensores = []
    for fuente in fuentes:
        texto = fuente.read_text(encoding="utf-8")
        if patron_lectura_env.search(texto) or patron_clave_hardcodeada.search(texto):
            ofensores.append(fuente.relative_to(REPO_ROOT).as_posix())

    assert not ofensores, (
        "El backend no debe leer claves de API/tokens de variables de entorno ni "
        f"embeberlas en el código; referencias encontradas en: {ofensores}"
    )



# ---------------------------------------------------------------------------
# CORS (bugfix): el navegador (frontend en :3000) debe poder llamar al backend
# (:8000). Sin CORS el navegador bloquea la respuesta -> "Failed to fetch".
# ---------------------------------------------------------------------------
def _cliente_con_deps_ok():
    """Devuelve un ``TestClient`` con la verificación de dependencias mockeada
    para que el arranque no aborte en el sandbox (sin ffmpeg/auto-editor)."""
    from fastapi.testclient import TestClient

    import main
    from app.deps import checker as _deps_checker

    def _verificacion_ok(*_args, **_kwargs):
        return _deps_checker.ResultadoVerificacion(
            resultados=[
                _deps_checker.ResultadoDependencia(nombre=n, disponible=True)
                for n in _deps_checker.DEPENDENCIAS
            ]
        )

    main.verificar_dependencias = _verificacion_ok  # type: ignore[assignment]
    return TestClient(main.app)


def test_cors_permite_origen_del_frontend():
    """Una petición con ``Origin: http://localhost:3000`` recibe el header
    ``access-control-allow-origin`` correspondiente (Req: CORS del bugfix)."""
    cliente = _cliente_con_deps_ok()
    respuesta = cliente.get("/salud", headers={"Origin": "http://localhost:3000"})

    assert respuesta.status_code == 200
    assert (
        respuesta.headers.get("access-control-allow-origin")
        == "http://localhost:3000"
    )


def test_cors_preflight_options_en_clips():
    """Un preflight ``OPTIONS`` a ``/clips`` responde con los headers CORS que
    permiten al navegador continuar con la petición real."""
    cliente = _cliente_con_deps_ok()
    respuesta = cliente.options(
        "/clips",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )

    assert respuesta.status_code in (200, 204)
    assert (
        respuesta.headers.get("access-control-allow-origin")
        == "http://localhost:3000"
    )
    allow_methods = respuesta.headers.get("access-control-allow-methods", "")
    assert "POST" in allow_methods or "*" in allow_methods
