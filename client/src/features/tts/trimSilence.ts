// Speech synthesis pads every sentence with silence on both ends. Played back
// to back, that padding adds up to a noticeable pause between sentences, so it
// is cut down to a short natural beat.
const SILENCE_THRESHOLD = 0.008;
const KEEP_LEAD_S = 0.03;
const KEEP_TAIL_S = 0.12;

/** Trims leading/trailing near-silence, keeping a short natural margin. Returns a standalone copy. */
export function trimSilence(samples: Float32Array, sampleRate: number): Float32Array<ArrayBuffer> {
  let first = 0;
  while (first < samples.length && Math.abs(samples[first]) < SILENCE_THRESHOLD) first++;
  if (first === samples.length) return samples.slice(); // all silence: leave as is
  let last = samples.length - 1;
  while (last > first && Math.abs(samples[last]) < SILENCE_THRESHOLD) last--;
  const start = Math.max(0, first - Math.round(KEEP_LEAD_S * sampleRate));
  const end = Math.min(samples.length, last + 1 + Math.round(KEEP_TAIL_S * sampleRate));
  return samples.slice(start, end);
}
