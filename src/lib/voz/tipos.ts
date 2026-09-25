/**
 * Contrato del proveedor de voz (ElevenLabs o mock). Solo server: la UI importa sus
 * tipos de `@/lib/types`, nunca de aca. Ver tasks/cambio-de-voz/02-DISENO.md §6.1.
 */
import type { AjustesDeVoz, CreditosDeVoz, VozResumen } from "../types";

/**
 * ElevenLabs usa ids alfanumericos de 20; el mock, "mock-<nombre>". Se valida ANTES de
 * armar la URL (D13): sin esto, un `../` del cliente entra al path del pedido a
 * ElevenLabs, que sale con la key del server.
 */
export const VOICE_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

export type ListaDeVoces = "mias" | "predeterminadas";

export interface PaginaDeVoces { voces: VozResumen[]; siguiente: string | null }

export interface ConvertirInput {
  voiceId: string;
  wav: Uint8Array;               // WAV PCM s16le mono 44.1 kHz (lo arma audio.ts)
  ajustes: AjustesDeVoz | null;
  quitarRuido: boolean;
  signal?: AbortSignal;
}

export interface ConvertirResultado {
  bytes: Uint8Array;
  extension: "mp3" | "wav";      // D20
  modelo: string;
}

export interface VozProvider {
  readonly nombre: "mock" | "elevenlabs";
  listar(lista: ListaDeVoces, opts?: { q?: string; cursor?: string | null }): Promise<PaginaDeVoces>;
  /** Resuelve hasta 100 ids (para las favoritas). Los que no existen, NO vienen. */
  porIds(ids: string[]): Promise<VozResumen[]>;
  convertir(input: ConvertirInput): Promise<ConvertirResultado>;
  /** Best-effort: null si no se puede saber (key sin permiso de user_read, mock). */
  creditos(): Promise<CreditosDeVoz | null>;
}

export type CodigoErrorDeVoz =
  | "no_configurado" | "key_invalida" | "sin_permiso" | "sin_creditos"
  | "voz_inexistente" | "limite" | "red" | "timeout" | "validacion" | "otro";

/**
 * Error de un proveedor de voz, ya clasificado. La corrida decide si reintenta mirando
 * `reintentable`, y la UI muestra `message`, que NUNCA incluye la key ni headers.
 *
 * Campos explicitos y no parameter properties: con type stripping de Node (que es como
 * los scripts de verificacion importan .ts) las parameter properties no se soportan.
 */
export class ErrorDeVoz extends Error {
  codigo: CodigoErrorDeVoz;
  status: number | null;
  retryAfterMs?: number;

  constructor(message: string, codigo: CodigoErrorDeVoz, status: number | null = null, retryAfterMs?: number) {
    super(message);
    this.name = "ErrorDeVoz";
    this.codigo = codigo;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }

  /** true solo para "limite" | "red" | "timeout". */
  get reintentable(): boolean {
    return this.codigo === "limite" || this.codigo === "red" || this.codigo === "timeout";
  }
}
