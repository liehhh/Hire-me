// Test doubles for the speech pipeline: a tone generator and a minimal
// AudioContext whose clock and buffer completion are driven manually.

export const SAMPLE_RATE = 24000;

export function tone(seconds: number, amplitude = 0.5): Float32Array {
  const samples = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < samples.length; i++) samples[i] = amplitude * Math.sin(i / 10);
  return samples;
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
