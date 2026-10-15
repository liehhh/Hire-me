// Shared types for interviewer speech. Plain data, so chunks can move between
// the speech client, the player and the avatar without conversion.

export interface SpeechConfig {
  /** Playback gain, 0..1. */
  volume: number;
}

export const DEFAULT_SPEECH_CONFIG: SpeechConfig = { volume: 1.0 };

/** One sentence of decoded speech. */
export interface TTSAudioChunk {
  chunkIndex: number;
  /** The sentence this chunk speaks — used for viseme timing. */
  text: string;
  /** Mono Float32 PCM samples. */
  audioData: ArrayBuffer;
  sampleRate: number;
  /** Seconds. */
  duration: number;
}

export type SynthesisOutcome = "completed" | "cancelled";
