import { interviewApi } from "../../api/interviewApi";
import { breadcrumb } from "../../lib/debugLog";
import { getAudioContext } from "./audioPlayback";
import { trimSilence } from "./trimSilence";
import type { SynthesisOutcome, TTSAudioChunk } from "./ttsTypes";

// The interviewer's voice: the server turns each sentence into MP3 (Deepgram
// Aura), the browser decodes it to PCM, and it flows into the playback and
// lip-sync path. Nothing is downloaded or run on the device beyond audio
// decoding, so it behaves the same on desktops and phones.

export interface DecodedAudio {
  samples: Float32Array;
  sampleRate: number;
}

export type FetchAudio = (text: string, signal: AbortSignal) => Promise<ArrayBuffer>;
export type DecodeAudio = (data: ArrayBuffer) => Promise<DecodedAudio>;

/** Sentences requested ahead of playback. Order of delivery is always preserved. */
const MAX_PARALLEL = 3;
const MIN_PIECE_CHARS = 40;
const MAX_PIECE_CHARS = 280;

/**
 * Splits a reply into sentence-sized requests so the first one can start
 * playing while the rest are still being fetched. Very short sentences are
 * merged into the next one and very long ones are split at commas or spaces.
 */
export function splitSentences(text: string): string[] {
  const sentences = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?…])\s+/)
    .filter(Boolean);

  const pieces: string[] = [];
  for (const sentence of sentences) {
    let rest = sentence;
    while (rest.length > MAX_PIECE_CHARS) {
      const window = rest.slice(0, MAX_PIECE_CHARS);
      const at = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(" "));
      const cut = at > MIN_PIECE_CHARS ? at + 1 : MAX_PIECE_CHARS;
      pieces.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) pieces.push(rest);
  }

  const merged: string[] = [];
  let carry = "";
  for (const piece of pieces) {
    const candidate = carry ? `${carry} ${piece}` : piece;
    if (candidate.length < MIN_PIECE_CHARS) carry = candidate;
    else {
      merged.push(candidate);
      carry = "";
    }
  }
  if (carry) {
    if (merged.length) merged[merged.length - 1] += ` ${carry}`;
    else merged.push(carry);
  }
  return merged;
}

const fromBase64 = (b64: string): ArrayBuffer => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};

const defaultFetchAudio: FetchAudio = async (text, signal) => {
  const { audio } = await interviewApi.speech({ text }, signal);
  return fromBase64(audio);
};

const defaultDecode: DecodeAudio = async (data) => {
  const buffer = await getAudioContext().decodeAudioData(data);
  return { samples: new Float32Array(buffer.getChannelData(0)), sampleRate: buffer.sampleRate };
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => undefined); // a failure is reported by whoever awaits it in order
  return { promise, resolve, reject };
}

export class CloudSpeechClient {
  private active: AbortController | null = null;

  constructor(
    private readonly fetchAudio: FetchAudio = defaultFetchAudio,
    private readonly decode: DecodeAudio = defaultDecode
  ) {}

  /**
   * Synthesizes text sentence by sentence. Starting a new synthesis cancels
   * the previous one. Resolves "cancelled" if cancel() (or a newer synthesize)
   * supersedes it, and rejects if a sentence cannot be fetched or decoded.
   */
  synthesize(text: string, onChunk: (chunk: TTSAudioChunk) => void): Promise<SynthesisOutcome> {
    this.cancel();
    const abort = new AbortController();
    this.active = abort;
    const { signal } = abort;

    const parts = splitSentences(text);
    const results = parts.map(() => deferred<DecodedAudio>());
    // Sentences that never started fetching must not leave the caller waiting.
    signal.addEventListener("abort", () => results.forEach((r) => r.reject(new Error("cancelled"))), { once: true });

    let started = 0;
    let inFlight = 0;
    const pump = () => {
      while (inFlight < MAX_PARALLEL && started < parts.length && !signal.aborted) {
        const i = started++;
        inFlight++;
        this.fetchAudio(parts[i], signal)
          .then((data) => this.decode(data))
          .then(results[i].resolve, results[i].reject)
          .finally(() => {
            inFlight--;
            pump();
          });
      }
    };
    pump();

    return (async (): Promise<SynthesisOutcome> => {
      try {
        for (let i = 0; i < parts.length; i++) {
          const { samples, sampleRate } = await results[i].promise;
          if (signal.aborted) return "cancelled";
          const trimmed = trimSilence(samples, sampleRate);
          breadcrumb(`speech: sentence ${i + 1}/${parts.length} ${(trimmed.length / sampleRate).toFixed(1)}s`);
          onChunk({
            chunkIndex: i,
            text: parts[i],
            audioData: trimmed.buffer,
            sampleRate,
            duration: trimmed.length / sampleRate,
          });
        }
        return signal.aborted ? "cancelled" : "completed";
      } catch (err) {
        if (signal.aborted) return "cancelled";
        abort.abort(); // stop fetching the remaining sentences
        breadcrumb(`speech: failed ${String(err)}`);
        throw err;
      } finally {
        if (this.active === abort) this.active = null;
      }
    })();
  }

  cancel(): void {
    this.active?.abort();
    this.active = null;
  }
}

let shared: CloudSpeechClient | null = null;

export function getCloudSpeechClient(): CloudSpeechClient {
  return (shared ??= new CloudSpeechClient());
}
