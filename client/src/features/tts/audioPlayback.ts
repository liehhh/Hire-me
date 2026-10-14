// Web Audio playback for Kokoro PCM output. Sentence chunks are scheduled
// back-to-back on the AudioContext clock, which also serves as the timing
// reference for the avatar's lip-sync (it freezes while paused, so mouth
// animation pauses with the audio).

let sharedContext: AudioContext | null = null;

/** One AudioContext for all interviewer speech, created on first use. */
export function getAudioContext(): AudioContext {
  if (!sharedContext || sharedContext.state === "closed") {
    sharedContext = new AudioContext();
  }
  return sharedContext;
}

/**
 * Creates/resumes the shared AudioContext. Call from a user gesture (e.g.
 * the "Start Interview" click) to satisfy browser autoplay policies.
 * Resolves true once audio is allowed to play.
 */
export async function unlockAudio(
  getContext: () => AudioContext = getAudioContext,
  timeoutMs = 500
): Promise<boolean> {
  const ctx = getContext();
  if (ctx.state === "running") return true;
  // Without user activation, resume() stays pending rather than rejecting,
  // so race it against a timeout.
  await Promise.race([
    ctx.resume().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  return (ctx.state as AudioContextState) === "running";
}

export type PlaybackState = "idle" | "playing" | "paused";

export interface UtteranceCallbacks {
  /** First chunk scheduled — audio is about to be audible. */
  onStart?: () => void;
  /** Every chunk finished playing after finish() was called. */
  onEnd?: () => void;
}

export interface ScheduledChunk {
  /** AudioContext time at which this chunk begins. */
  startAt: number;
  duration: number;
}

// Small lead time so the first chunk isn't clipped while the graph spins up.
const START_LEAD_S = 0.05;

export class SpeechPlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private nextStartAt = 0;
  private utterance = 0;
  private callbacks: UtteranceCallbacks = {};
  private started = false;
  private finished = false;
  private firstStartAt = 0;
  private totalDuration = 0;
  state: PlaybackState = "idle";

  constructor(private getContext: () => AudioContext = getAudioContext) {}

  /** Starts a new utterance, stopping whatever was playing (without onEnd). */
  begin(volume: number, callbacks: UtteranceCallbacks): void {
    this.stop();
    this.utterance++;
    this.callbacks = callbacks;
    this.ctx = this.getContext();
    this.gain = this.ctx.createGain();
    this.gain.gain.value = volume;
    this.gain.connect(this.ctx.destination);
    this.nextStartAt = 0;
    this.started = false;
    this.finished = false;
    this.totalDuration = 0;
  }

  /** Queues a mono PCM chunk directly after the previous one. */
  enqueue(samples: Float32Array, sampleRate: number): ScheduledChunk | null {
    const ctx = this.ctx;
    const gain = this.gain;
    if (!ctx || !gain || this.finished) return null;

    const buffer = ctx.createBuffer(1, samples.length, sampleRate);
    buffer.getChannelData(0).set(samples);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);

    const startAt = Math.max(ctx.currentTime + START_LEAD_S, this.nextStartAt);
    this.nextStartAt = startAt + buffer.duration;
    this.totalDuration += buffer.duration;

    const utterance = this.utterance;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
      if (utterance === this.utterance) this.maybeEnd();
    };
    source.start(startAt);

    if (this.state !== "paused") this.state = "playing";
    if (!this.started) {
      this.started = true;
      this.firstStartAt = startAt;
      this.callbacks.onStart?.();
    }
    return { startAt, duration: buffer.duration };
  }

  /** No more chunks are coming; onEnd fires once queued audio drains. */
  finish(): void {
    this.finished = true;
    this.maybeEnd();
  }

  async pause(): Promise<void> {
    if (this.state !== "playing" || !this.ctx) return;
    this.state = "paused";
    await this.ctx.suspend();
  }

  async resume(): Promise<void> {
    if (this.state !== "paused" || !this.ctx) return;
    this.state = "playing";
    await this.ctx.resume();
  }

  /** Immediately silences the current utterance. Does not call onEnd. */
  stop(): void {
    this.utterance++;
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
      source.disconnect();
    }
    this.sources.clear();
    this.gain?.disconnect();
    this.gain = null;
    this.callbacks = {};
    // A paused context would also hold back the next utterance.
    if (this.state === "paused") void this.ctx?.resume();
    this.state = "idle";
  }

  /** Current time on the playback clock (AudioContext seconds). */
  now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  /** Seconds of the current utterance that have played so far. */
  get elapsed(): number {
    if (!this.started || !this.ctx) return 0;
    return Math.min(this.totalDuration, Math.max(0, this.ctx.currentTime - this.firstStartAt));
  }

  /** Total seconds of audio queued for the current utterance. */
  get duration(): number {
    return this.totalDuration;
  }

  private maybeEnd() {
    if (!this.finished || this.sources.size > 0) return;
    const { onEnd } = this.callbacks;
    this.callbacks = {};
    this.gain?.disconnect();
    this.gain = null;
    this.state = "idle";
    onEnd?.();
  }
}
