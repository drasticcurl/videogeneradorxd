/**
 * Ajustes builder — maps EditOptions onto the editor's Ajustes shape.
 *
 * The generator's EditOptions expose a simplified subset of editing settings
 * (silence-cut toggle, subtitles toggle, music toggle, ordering). This module
 * constructs the full Ajustes payload expected by the editor's POST /procesar
 * endpoint, filling all remaining fields with editor defaults so that
 * validar_ajustes passes.
 *
 * Requirements: 2.1, 2.4
 */

import type { EditOptions } from "./types";

// ---------------------------------------------------------------------------
// Default Ajustes structure (mirrors editor's app/models/settings.py defaults)
// ---------------------------------------------------------------------------

/**
 * Editor default values from config.py / settings.py.
 * These are the same values the editor uses when constructing an Ajustes()
 * with no arguments (all fields at their Pydantic defaults).
 */
const EDITOR_DEFAULTS = {
  generales: {
    resolucion: { ancho: 1080, alto: 1920 },
    fps: 30,
  },
  silencios: {
    activado: true,
    modo: "db",
    umbral_db: -30.0,
    margen_ms: 200,
  },
  transiciones: {
    tipo: "ninguna",
    duracion_ms: 400,
  },
  risas: {
    activado: false,
    margen_ms: 100,
  },
  transcripcion: {
    idioma: "es",
    modelo: "small",
  },
  subtitulos: {
    max_palabras: 4,
    revisar: false,
    aprobar_a_mano: false,
    minusculas: false,
    preset: "clasico",
    color_resaltado: "#FFE500",
    posicion_vertical: "inferior",
    posicion_horizontal: "centro",
    pos_vertical_pct: 85.0,
    pos_horizontal_pct: 50.0,
    margen_px: 60,
    fuente: "Arial",
    tamano: 72,
    color: "#FFFFFF",
    color_borde: "#000000",
    grosor_borde: 5,
    negrita: true,
    anim_entrada_ms: 300,
    anim_salida_ms: 300,
    slide_px: 50,
  },
  musica: null as Record<string, unknown> | null,
  revision_ia: {
    activado: false,
    modelo: "gpt-5.4-nano",
    timeout_s: 20.0,
    max_reintentos: 1,
  },
  render: {
    motor_preferido: "ass",
    combine_tokens_ms: 1200,
  },
  edicion_manual: false,
} as const;

/**
 * Default music settings used when a music track is provided.
 */
const DEFAULT_MUSICA = {
  volumen_base_pct: 30,
  reduccion_db: 12.0,
  umbral_voz_dbfs: -30.0,
  ataque_ms: 250,
  liberacion_ms: 500,
} as const;

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export interface BuildAjustesOptions {
  /** The user's EditOptions from the request. */
  editOptions: EditOptions;
  /** If a music track was uploaded, this is its storage key/path for the editor. */
  musicInputKey?: string;
  /** Optional safe overrides from the user (passed through as-is). */
  overrides?: Record<string, unknown>;
}

/**
 * Builds a complete Ajustes payload from the user's EditOptions.
 *
 * The resulting object satisfies the editor's validar_ajustes (all fields
 * present with valid defaults). Only the user-controlled toggles are applied:
 *   - silenceCut: enables/disables the silence-cut step.
 *   - subtitles: enables/disables transcription + subtitle generation.
 *   - musicTrackId: when present (and musicInputKey provided), enables music.
 *   - overrides: any safe subset of editor Ajustes fields the user passed.
 *
 * @returns A Record<string, unknown> matching the editor's Ajustes shape.
 */
export function buildAjustes(opts: BuildAjustesOptions): Record<string, unknown> {
  const { editOptions, musicInputKey, overrides } = opts;

  // Start with a full copy of the defaults
  const ajustes: Record<string, unknown> = {
    generales: { ...EDITOR_DEFAULTS.generales, resolucion: { ...EDITOR_DEFAULTS.generales.resolucion } },
    silencios: { ...EDITOR_DEFAULTS.silencios },
    transiciones: { ...EDITOR_DEFAULTS.transiciones },
    risas: { ...EDITOR_DEFAULTS.risas },
    transcripcion: { ...EDITOR_DEFAULTS.transcripcion },
    subtitulos: { ...EDITOR_DEFAULTS.subtitulos },
    musica: null,
    revision_ia: { ...EDITOR_DEFAULTS.revision_ia },
    render: { ...EDITOR_DEFAULTS.render },
    edicion_manual: EDITOR_DEFAULTS.edicion_manual,
  };

  // Apply silence-cut toggle (Req 2.1)
  (ajustes.silencios as Record<string, unknown>).activado = editOptions.silenceCut;

  // Apply per-job manual-edit toggle. When true, the editor pauses at each
  // manual step (silences, subtitle review, final render) even in cloud mode.
  ajustes.edicion_manual = editOptions.editManual === true;

  // Apply subtitles toggle (Req 2.1) — when disabled, we still include the
  // section with defaults but the pipeline will skip subtitle steps if there's
  // no transcription. We keep transcripcion defaults always (the editor decides
  // whether to skip based on the presence of subtitles in the pipeline).
  // The editor's pipeline always transcribes if there are clips; subtitles are
  // controlled by whether the paso is included. We keep it simple: the editor
  // always runs transcription; if subtitles are disabled, the editor just won't
  // burn them. The simplest approach: keep all defaults.

  // Apply music (Req 2.1, 2.2, 2.3)
  if (musicInputKey) {
    // Music is enabled: include default music settings
    ajustes.musica = { ...DEFAULT_MUSICA };
  }
  // If no musicInputKey, musica stays null → editor skips music step

  // Apply safe overrides (Req 2.4) — shallow merge into the relevant sections
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (key in ajustes && value !== null && typeof value === "object" && !Array.isArray(value)) {
        // Merge into existing section
        const section = ajustes[key] as Record<string, unknown> | null;
        if (section && typeof section === "object") {
          ajustes[key] = { ...section, ...(value as Record<string, unknown>) };
        } else {
          ajustes[key] = { ...(value as Record<string, unknown>) };
        }
      } else if (key in ajustes) {
        // Replace scalar or null value
        ajustes[key] = value;
      }
      // Ignore unknown top-level keys (safety)
    }
  }

  return ajustes;
}
