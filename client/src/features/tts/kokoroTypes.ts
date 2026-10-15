// Shared types/constants for the local Kokoro TTS pipeline. Everything here
// is plain data so it can cross the Web Worker boundary via postMessage.

/** Hugging Face model repo that kokoro-js loads its ONNX weights from. */
export const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

/**
 * Default interviewer voice. `af_heart` is the only "A"-graded voice in
 * kokoro-js 1.2.1's voice table (see node_modules/kokoro-js/README.md) — a
 * calm, clear American English female voice, which also matches the
 * default (female) TalkingHead avatar. Any key of kokoro-js's VOICES works.
 */
export const DEFAULT_KOKORO_VOICE = "af_heart";

export interface KokoroVoiceConfig {
  voice: string;
  /** Kokoro speaking rate, 1 = natural. Slightly faster keeps the interview brisk. */
  speed: number;
  /** Playback gain, 0..1. */
  volume: number;
}

export const DEFAULT_TTS_CONFIG: KokoroVoiceConfig = {
  speed: 1.1,
  volume: 1.0,
  voice: DEFAULT_KOKORO_VOICE,
};

export type KokoroDevice = "webgpu" | "wasm";

// --- Worker protocol -------------------------------------------------------
// Every synthesize request carries a requestId so stale audio from a
// cancelled/superseded request can be discarded on both sides of the
// boundary. Audio arrives as one "audio" message per sentence (Kokoro's own
// sentence splitter), so playback can start before the full reply is ready.

export type TTSWorkerRequest =
  | { type: "load-model"; voice: string; device?: KokoroDevice }
  | { type: "synthesize"; requestId: number; text: string; voice: string; speed?: number }
  | { type: "cancel"; requestId?: number };

export type TTSWorkerResponse =
  | { type: "loading"; progress?: number }
  | { type: "log"; message: string }
  | { type: "ready"; device: KokoroDevice }
  | {
      type: "audio";
      requestId: number;
      chunkIndex: number;
      /** The sentence this chunk speaks — used for viseme timing. */
      text: string;
      /** Mono Float32 PCM samples (transferred, not copied). */
      audioData: ArrayBuffer;
      sampleRate: number;
      duration: number;
    }
  | { type: "done"; requestId: number }
  | { type: "error"; requestId?: number; message: string };

export interface TTSAudioChunk {
  chunkIndex: number;
  text: string;
  audioData: ArrayBuffer;
  sampleRate: number;
  duration: number;
}

export type SynthesisOutcome = "completed" | "cancelled";
