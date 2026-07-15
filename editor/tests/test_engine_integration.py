"""Tests de integración de los pasos del pipeline (Tarea 11.10, Req 4, 5, 7, 8).

Como los binarios reales (ffmpeg/ffprobe/auto-editor) y faster-whisper pueden no
estar instalados en el entorno, estos tests **inyectan dobles/mocks** que
verifican que cada paso construye los comandos/filtros correctos y encadena la
lógica esperada, sin ejecutar herramientas externas reales:

* **Corte de silencios (Req 4.1):** ``cortar_silencios`` construye el comando
  ``auto-editor`` con el umbral (%) y el margen (s) convertidos desde la UI.
* **Transcripción (Req 5.1, 5.4):** ``transcribir`` extrae audio, transcribe con
  ``word_timestamps=True`` y ``language=None`` cuando el idioma es "auto", y
  devuelve ``list[Palabra]`` con los timestamps.
* **Quemado de subtítulos (Req 7.2):** ``generar_y_quemar_subtitulos`` escribe el
  ``.ass`` e invoca ffmpeg con ``-vf ass=...``.
* **Ducking (Req 8.3, 8.5, 8.6):** el filtro incluye ``sidechaincompress`` con
  reducción >= 12 dB, ataque <= 250 ms y liberación <= 500 ms.
* **Unión (Req 3.4, 3.6):** ``unir_clips`` normaliza y concatena en orden, y un
  clip corrupto detiene la unión sin salida parcial.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, List, Sequence

import pytest

from app import config
from app.engine.proc import ResultadoComando


# ---------------------------------------------------------------------------
# Dobles compartidos
# ---------------------------------------------------------------------------
class RunnerGrabador:
    """Runner inyectable que registra los comandos y simula un código de salida."""

    def __init__(self, returncode: int = 0, stderr: str = "") -> None:
        self.returncode = returncode
        self.stderr = stderr
        self.comandos: List[List[str]] = []

    def __call__(self, args: Sequence[str]) -> ResultadoComando:
        self.comandos.append(list(args))
        return ResultadoComando(
            returncode=self.returncode, stderr=self.stderr, args=list(args)
        )


# ===========================================================================
# Corte de silencios (Req 4.1)
# ===========================================================================
def test_integracion_corte_silencios_construye_comando(tmp_path: Path) -> None:
    """El corte activado invoca auto-editor con umbral(%) y margen(s) convertidos."""
    from app.engine.silence import cortar_silencios

    runner = RunnerGrabador(returncode=0)
    entrada = tmp_path / "unido.mp4"
    salida = tmp_path / "cortado.mp4"

    resultado = cortar_silencios(
        entrada,
        salida,
        activado=True,
        umbral_db=0.0,   # 0 dB -> 100 % del motor
        margen_ms=2000,  # 2000 ms -> 2 s
        runner=runner,
        engine="auto-editor",
    )

    assert resultado == salida
    assert len(runner.comandos) == 1
    comando = runner.comandos[0]
    assert comando[0] == "auto-editor"
    # Umbral 0 dB equivale al 100 % del motor; margen 2000 ms -> 2 s.
    assert "audio:threshold=100%" in comando
    assert "2s" in comando


# ===========================================================================
# Transcripción (Req 5.1, 5.4)
# ===========================================================================
class _FakeWord:
    def __init__(self, word: str, start: float, end: float) -> None:
        self.word = word
        self.start = start
        self.end = end


class _FakeSegment:
    def __init__(self, words: List[_FakeWord]) -> None:
        self.words = words


class _FakeModel:
    """Modelo faster-whisper simulado que registra los parámetros de transcribe."""

    def __init__(self, registro: dict) -> None:
        self._registro = registro

    def transcribe(self, audio: str, language: Any = None, word_timestamps: bool = False):
        self._registro["audio"] = audio
        self._registro["language"] = language
        self._registro["word_timestamps"] = word_timestamps
        segments = [
            _FakeSegment([_FakeWord("hola", 0.0, 0.5), _FakeWord("mundo", 0.5, 1.0)]),
        ]
        return segments, {"language": "es"}


def test_integracion_transcripcion_devuelve_palabras(tmp_path: Path) -> None:
    """La transcripción usa word_timestamps=True y devuelve list[Palabra] (Req 5.1)."""
    from app.engine.transcribe import transcribir
    from app.models.settings import AjustesTranscripcion, Palabra

    registro: dict = {}
    extracciones: List = []

    def _extractor(video: str, audio_wav: str) -> None:
        extracciones.append((video, audio_wav))

    def _factory(modelo: str) -> _FakeModel:
        registro["modelo"] = modelo
        return _FakeModel(registro)

    ajustes = AjustesTranscripcion(idioma="es", modelo="small")
    palabras = transcribir(
        tmp_path / "cortado.mp4",
        ajustes,
        tmp_path / "audio.wav",
        extractor=_extractor,
        modelo_factory=_factory,
    )

    assert len(extracciones) == 1
    assert registro["word_timestamps"] is True
    assert registro["language"] == "es"
    assert all(isinstance(p, Palabra) for p in palabras)
    assert [p.texto for p in palabras] == ["hola", "mundo"]
    assert palabras[0].inicio_s == 0.0 and palabras[0].fin_s == 0.5


def test_integracion_transcripcion_auto_usa_language_none(tmp_path: Path) -> None:
    """Con idioma "auto" se pasa language=None para detección automática (Req 5.4)."""
    from app.engine.transcribe import transcribir
    from app.models.settings import AjustesTranscripcion

    registro: dict = {}

    def _extractor(video: str, audio_wav: str) -> None:
        pass

    def _factory(modelo: str) -> _FakeModel:
        return _FakeModel(registro)

    ajustes = AjustesTranscripcion(idioma="auto", modelo="tiny")
    transcribir(
        tmp_path / "v.mp4",
        ajustes,
        tmp_path / "a.wav",
        extractor=_extractor,
        modelo_factory=_factory,
    )
    assert registro["language"] is None


# ===========================================================================
# Quemado de subtítulos (Req 7.2)
# ===========================================================================
def test_integracion_quemado_subtitulos_construye_comando(tmp_path: Path) -> None:
    """Se escribe el .ass y ffmpeg se invoca con -vf ass=... (Req 7.1, 7.2)."""
    from app.engine.subtitles import generar_y_quemar_subtitulos
    from app.models.settings import AjustesSubtitulos, Palabra, ResolucionObjetivo

    runner = RunnerGrabador(returncode=0)
    ass_path = tmp_path / "subtitulos.ass"
    salida = tmp_path / "subtitulado.mp4"
    palabras = [Palabra(texto="hola", inicio_s=0.0, fin_s=0.4), Palabra(texto="qué", inicio_s=0.4, fin_s=0.8)]

    resultado = generar_y_quemar_subtitulos(
        tmp_path / "cortado.mp4",
        palabras,
        AjustesSubtitulos(),
        ResolucionObjetivo(),
        ass_path,
        salida,
        runner=runner,
        existe_salida=lambda _p: True,
    )

    assert resultado == salida
    # El archivo ASS fue escrito con contenido válido.
    assert ass_path.exists()
    contenido = ass_path.read_text(encoding="utf-8")
    assert "[Events]" in contenido and "Dialogue:" in contenido
    # ffmpeg se invocó con el filtro ass=.
    assert len(runner.comandos) == 1
    comando = runner.comandos[0]
    assert comando[0] == "ffmpeg"
    assert "-vf" in comando
    # ffmpeg 8.x requiere la opción nombrada `filename=` (no la ruta posicional).
    from app.engine.subtitles import _escapar_ruta_ass

    assert any(
        arg == "ass=filename=%s" % _escapar_ruta_ass(str(ass_path)) for arg in comando
    )


def test_integracion_quemado_subtitulos_rechaza_config_invalida(tmp_path: Path) -> None:
    """Configuración de subtítulos fuera de rango se rechaza antes de quemar (Req 7.11)."""
    from app.engine.subtitles import (
        ConfiguracionSubtitulosError,
        generar_y_quemar_subtitulos,
    )
    from app.models.settings import AjustesSubtitulos, ResolucionObjetivo

    runner = RunnerGrabador(returncode=0)
    subtitulos = AjustesSubtitulos()
    subtitulos.tamano = 5  # < 12 (fuera del rango del motor)

    with pytest.raises(ConfiguracionSubtitulosError):
        generar_y_quemar_subtitulos(
            tmp_path / "cortado.mp4",
            [],
            subtitulos,
            ResolucionObjetivo(),
            tmp_path / "s.ass",
            tmp_path / "s.mp4",
            runner=runner,
        )
    # No se invocó ffmpeg.
    assert runner.comandos == []


def test_integracion_quemado_subtitulos_falla_si_ffmpeg_falla(tmp_path: Path) -> None:
    """ffmpeg con código != 0 => SubtitulosError, conservando el original (Req 7.10)."""
    from app.engine.subtitles import SubtitulosError, generar_y_quemar_subtitulos
    from app.models.settings import AjustesSubtitulos, ResolucionObjetivo

    runner = RunnerGrabador(returncode=1, stderr="boom")
    with pytest.raises(SubtitulosError):
        generar_y_quemar_subtitulos(
            tmp_path / "cortado.mp4",
            [],
            AjustesSubtitulos(),
            ResolucionObjetivo(),
            tmp_path / "s.ass",
            tmp_path / "s.mp4",
            runner=runner,
            existe_salida=lambda _p: False,
        )


# ===========================================================================
# Ducking (Req 8.3, 8.5, 8.6)
# ===========================================================================
def test_integracion_ducking_parametros_y_filtro() -> None:
    """El filtro incluye sidechaincompress con reducción >= 12 dB, ataque <= 250 ms
    y liberación <= 500 ms (Req 8.3, 8.5, 8.6)."""
    from app.engine.music import (
        calcular_parametros_ducking,
        construir_filtro_ducking,
    )
    from app.models.settings import AjustesMusica

    params = calcular_parametros_ducking(AjustesMusica())

    # Parámetros dentro de las cotas exigidas por el diseño.
    assert params.reduccion_db >= 12.0            # Req 8.5
    assert params.ataque_ms <= 250                # Req 8.5
    assert params.liberacion_ms <= 500            # Req 8.6
    # Umbral de voz -30 dBFS convertido a amplitud lineal (~0.0316).
    assert 0.0 < params.threshold_lin < 1.0

    filtro = construir_filtro_ducking(params)
    assert "sidechaincompress" in filtro          # Req 8.3
    assert "amix" in filtro
    assert "attack=%d" % params.ataque_ms in filtro
    assert "release=%d" % params.liberacion_ms in filtro


def test_integracion_ducking_mezcla_invoca_ffmpeg(tmp_path: Path) -> None:
    """mezclar_musica con WAV válido invoca ffmpeg con filter_complex de ducking."""
    from app.engine.music import mezclar_musica
    from app.models.settings import AjustesMusica

    runner = RunnerGrabador(returncode=0)
    salida = tmp_path / "final.mp4"
    resultado = mezclar_musica(
        tmp_path / "subtitulado.mp4",
        tmp_path / "musica.wav",
        AjustesMusica(),
        salida,
        runner=runner,
    )
    assert resultado == salida
    assert len(runner.comandos) == 1
    comando = runner.comandos[0]
    assert comando[0] == "ffmpeg"
    assert "-filter_complex" in comando
    idx = comando.index("-filter_complex")
    assert "sidechaincompress" in comando[idx + 1]


def test_integracion_ducking_omite_sin_wav(tmp_path: Path) -> None:
    """Sin WAV de música el paso se omite y devuelve el video de entrada (Req 8.3)."""
    from app.engine.music import mezclar_musica
    from app.models.settings import AjustesMusica

    runner = RunnerGrabador(returncode=0)
    entrada = tmp_path / "subtitulado.mp4"
    resultado = mezclar_musica(entrada, None, AjustesMusica(), tmp_path / "final.mp4", runner=runner)
    assert resultado == entrada
    assert runner.comandos == []


# ===========================================================================
# Unión / normalización (Req 3.4, 3.6)
# ===========================================================================
def _fake_clip_info(ruta: str, tiene_audio: bool = True):
    from app.engine.ffprobe import ClipInfo

    return ClipInfo(
        ruta=ruta,
        ancho=1920,
        alto=1080,
        rotacion=0,
        fps=30.0,
        duracion_s=5.0,
        tiene_video=True,
        tiene_audio=tiene_audio,
    )


def test_integracion_unir_clips_preserva_orden(tmp_path: Path, monkeypatch) -> None:
    """unir_clips normaliza cada clip y concatena en el orden del usuario (Req 3.4)."""
    monkeypatch.setattr(config, "WORKDIR_ROOT", tmp_path / "wk")
    monkeypatch.setattr(config, "OUTPUT_ROOT", tmp_path / "out")
    from app.engine.normalize import NOMBRE_UNIDO, unir_clips
    from app.storage.workdir import JobWorkdir

    job = JobWorkdir("job-unir")
    runner = RunnerGrabador(returncode=0)

    rutas = ["/clips/a.mp4", "/clips/b.mov", "/clips/c.mkv"]
    resultado = unir_clips(
        job,
        rutas,
        ancho_objetivo=1080,
        alto_objetivo=1920,
        fps=30,
        runner=runner,
        inspector=lambda r: _fake_clip_info(r),
    )

    assert resultado.name == NOMBRE_UNIDO
    # 3 normalizaciones + 1 concatenación.
    assert len(runner.comandos) == 4
    # El último comando es la concatenación.
    assert "concat" in runner.comandos[-1]
    # concat.txt refleja el orden del usuario, elemento a elemento.
    concat_txt = job.resolve("concat.txt")
    from app.engine.normalize import parsear_concat_txt

    referencias = parsear_concat_txt(concat_txt.read_text(encoding="utf-8"))
    assert [Path(r).name for r in referencias] == ["norm_000.mp4", "norm_001.mp4", "norm_002.mp4"]


def test_integracion_unir_clips_clip_corrupto_detiene(tmp_path: Path, monkeypatch) -> None:
    """Un clip no decodificable detiene la unión sin producir salida (Req 3.6)."""
    monkeypatch.setattr(config, "WORKDIR_ROOT", tmp_path / "wk")
    monkeypatch.setattr(config, "OUTPUT_ROOT", tmp_path / "out")
    from app.engine.ffprobe import ClipInspeccionError
    from app.engine.normalize import NOMBRE_UNIDO, NormalizacionError, unir_clips
    from app.storage.workdir import JobWorkdir

    job = JobWorkdir("job-corrupto")
    runner = RunnerGrabador(returncode=0)

    def _inspector(ruta: str):
        if ruta.endswith("malo.mp4"):
            raise ClipInspeccionError(ruta, "sin stream de video decodificable")
        return _fake_clip_info(ruta)

    with pytest.raises(NormalizacionError) as exc:
        unir_clips(
            job,
            ["/clips/bueno.mp4", "/clips/malo.mp4"],
            ancho_objetivo=1080,
            alto_objetivo=1920,
            fps=30,
            runner=runner,
            inspector=_inspector,
        )
    assert exc.value.ruta == "/clips/malo.mp4"
    # Sin salida parcial: no se ejecutó ninguna normalización ni concatenación,
    # y no existe el artefacto unido.
    assert runner.comandos == []
    assert not job.resolve(NOMBRE_UNIDO).exists()



# ===========================================================================
# Inspección de clips con ffprobe (Req 3.6)
# ===========================================================================
def test_integracion_ffprobe_parsea_resolucion_fps_rotacion() -> None:
    """parsear_salida_ffprobe extrae resolución, fps y rotación del JSON."""
    import json

    from app.engine.ffprobe import parsear_salida_ffprobe

    salida = json.dumps(
        {
            "streams": [
                {
                    "codec_type": "video",
                    "width": 1920,
                    "height": 1080,
                    "avg_frame_rate": "30000/1001",
                    "tags": {"rotate": "90"},
                },
                {"codec_type": "audio"},
            ],
            "format": {"duration": "12.5"},
        }
    )
    info = parsear_salida_ffprobe("/clips/x.mp4", salida)
    assert info.ancho == 1920 and info.alto == 1080
    assert info.rotacion == 90
    assert info.tiene_audio is True
    assert abs(info.fps - (30000 / 1001)) < 1e-6
    assert info.duracion_s == 12.5


def test_integracion_ffprobe_clip_sin_video_es_error() -> None:
    """Un archivo sin stream de video se trata como no decodificable (Req 3.6)."""
    import json

    from app.engine.ffprobe import ClipInspeccionError, parsear_salida_ffprobe

    salida = json.dumps({"streams": [{"codec_type": "audio"}], "format": {}})
    with pytest.raises(ClipInspeccionError):
        parsear_salida_ffprobe("/clips/solo_audio.wav", salida)


def test_integracion_ffprobe_json_invalido_es_error() -> None:
    """Una salida de ffprobe ilegible se trata como clip corrupto (Req 3.6)."""
    from app.engine.ffprobe import ClipInspeccionError, parsear_salida_ffprobe

    with pytest.raises(ClipInspeccionError):
        parsear_salida_ffprobe("/clips/corrupto.mp4", "esto no es json")


def test_integracion_ffprobe_inspeccionar_falla_si_ffprobe_falla() -> None:
    """Si ffprobe devuelve código != 0, se marca el clip como no decodificable."""
    from app.engine.ffprobe import ClipInspeccionError, inspeccionar_clip

    runner = RunnerGrabador(returncode=1, stderr="moov atom not found")
    with pytest.raises(ClipInspeccionError):
        inspeccionar_clip("/clips/roto.mp4", runner=runner)
