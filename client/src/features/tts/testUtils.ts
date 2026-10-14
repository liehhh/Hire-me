import type { WorkerLike } from "./kokoroClient";
import type { TTSWorkerRequest, TTSWorkerResponse } from "./kokoroTypes";
import { createKokoroWorkerHandler, type EngineLoader, type KokoroEngine } from "./kokoroWorkerCore";

// Test doubles for the TTS pipeline: a fake Kokoro engine, an in-process
// "worker" running the real worker core, and a minimal AudioContext whose
// clock and buffer completion are driven manually.

export const SAMPLE_RATE = 24000;

export function tone(seconds: number, amplitude = 0.5): Float32Array {
  const samples = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < samples.length; i++) samples[i] = amplitude * Math.sin(i / 10);
  return samples;
}

/** Splits on sentence punctuation, yielding 0.5s of audio per sentence. */
export function createFakeEngine(opts: { failOn?: string; delayMs?: number } = {}): KokoroEngine {
  return {
    async *stream(text) {
      const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text];
      for (const sentence of sentences) {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        else await Promise.resolve();
        if (opts.failOn && sentence.includes(opts.failOn)) throw new Error("inference failed");
        yield { text: sentence.trim(), audio: { audio: tone(0.5), sampling_rate: SAMPLE_RATE } };
      }
    },
  };
}

export class InProcessWorker implements WorkerLike {
  received: TTSWorkerRequest[] = [];
  terminated = false;
  private messageListeners: ((e: MessageEvent<TTSWorkerResponse>) => void)[] = [];
  private errorListeners: ((e: ErrorEvent) => void)[] = [];
  private handle: (req: TTSWorkerRequest) => Promise<void>;

  constructor(loader: EngineLoader) {
    this.handle = createKokoroWorkerHandler(loader, (message) => {
      if (this.terminated) return;
      // Deliver asynchronously, like a real worker.
      queueMicrotask(() => {
        if (!this.terminated) this.messageListeners.forEach((l) => l({ data: message } as MessageEvent));
      });
    });
  }

  postMessage(message: TTSWorkerRequest) {
    this.received.push(message);
    void this.handle(message);
  }

  addEventListener(type: "message" | "error", listener: (e: never) => void) {
    if (type === "message") this.messageListeners.push(listener as never);
    else this.errorListeners.push(listener as never);
  }

  crash(message: string) {
    this.terminated = true; // a crashed worker posts nothing further
    this.errorListeners.forEach((l) => l({ message } as ErrorEvent));
  }

  terminate() {
    this.terminated = true;
  }
}

export function fakeLoader(engine: KokoroEngine = createFakeEngine()): EngineLoader & { calls: number } {
  const loader = Object.assign(
    async (onProgress: (p: number) => void) => {
      loader.calls++;
      onProgress(50);
      onProgress(100);
      return { engine, device: "wasm" as const };
    },
    { calls: 0 }
  );
  return loader;
}

class FakeBufferSource {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stopped = false;
  constructor(private ctx: FakeAudioContext) {}
  connect() {}
  disconnect() {}
  start(when = 0) {
    this.startedAt = when;
    this.ctx.sources.push(this);
  }
  stop() {
    this.stopped = true;
  }
}

export class FakeAudioContext {
  currentTime = 0;
  state: AudioContextState = "running";
  destination = {};
  sources: FakeBufferSource[] = [];

  createGain() {
    return { gain: { value: 1 }, connect() {}, disconnect() {} };
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    const data = new Float32Array(length);
    return { duration: length / sampleRate, getChannelData: () => data };
  }
  createBufferSource() {
    return new FakeBufferSource(this);
  }
  async resume() {
    this.state = "running";
  }
  async suspend() {
    this.state = "suspended";
  }

  /** Advances the clock and fires onended for every source that has finished. */
  advance(seconds: number) {
    this.currentTime += seconds;
    for (const s of this.sources) {
      if (s.stopped || s.startedAt === null || !s.buffer) continue;
      if (this.currentTime >= s.startedAt + s.buffer.duration) {
        s.stopped = true;
        s.onended?.();
      }
    }
  }

  asAudioContext(): AudioContext {
    return this as unknown as AudioContext;
  }
}

export const flush = () => new Promise((r) => setTimeout(r, 0));

export const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1];
