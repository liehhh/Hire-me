// Decides when to start playing a reply that is still being generated.
//
// Speech arrives one sentence at a time. On a fast connection each sentence is
// ready long before the previous one finishes playing, so playback starts on
// the first sentence. On a slow one (fetching slower than real time) starting
// right away leaves a silent gap at every full stop while the next sentence
// arrives. Instead, playback is held back just long enough that the buffered
// audio outlasts fetching the rest: one slightly longer wait up front, then
// continuous speech.

/** Extra margin on the estimate, since sentence lengths vary. */
const SAFETY = 1.15;

export class PrebufferGate {
  private audioSeconds = 0;
  private chars = 0;
  private chunks = 0;
  private readonly startedAt: number;

  constructor(
    private readonly totalChars: number,
    private readonly now: () => number = () => performance.now()
  ) {
    this.startedAt = now();
  }

  /**
   * Records one generated chunk. Returns true once everything buffered so
   * far can start playing without running dry before the rest is generated.
   */
  add(textLength: number, durationSeconds: number): boolean {
    this.audioSeconds += durationSeconds;
    this.chars += textLength;
    this.chunks++;

    const remainingChars = this.totalChars - this.chars;
    if (remainingChars <= 0 || this.audioSeconds <= 0) return true;

    // Seconds of generation per second of audio, measured on this device.
    const rate = (this.now() - this.startedAt) / 1000 / this.audioSeconds;
    const remainingAudio = remainingChars * (this.audioSeconds / Math.max(1, this.chars));
    const avgChunk = this.audioSeconds / this.chunks;
    // Playing B seconds now never stalls if each later sentence is generated
    // before playback reaches it: B >= rate·next and B >= (rate−1)·remaining + next.
    const needed = Math.max(rate * avgChunk, ((rate - 1) * remainingAudio + avgChunk) * SAFETY);
    return this.audioSeconds >= needed;
  }
}
