// Deterministic lip-sync timing. Kokoro returns audio without word or
// phoneme timestamps, so we approximate them: the text is converted to
// Oculus visemes (TalkingHead's morph target set), relative viseme
// durations are stretched to fit the span of the audio that actually
// contains speech, and a loudness envelope of the same audio lets the
// mouth close during real pauses. Same text + same audio → same timeline.

export type Viseme =
  | "sil" | "PP" | "FF" | "TH" | "DD" | "kk" | "CH" | "SS"
  | "nn" | "RR" | "aa" | "E" | "I" | "O" | "U";

export interface VisemeEvent {
  viseme: Viseme;
  /** Seconds from the start of the audio chunk. */
  start: number;
  end: number;
  /** Peak morph target value, 0..1. */
  weight: number;
}

export interface WordVisemes {
  visemes: string[];
  /** Relative durations (arbitrary units), one per viseme. */
  durations: number[];
}

export type WordToVisemes = (word: string) => WordVisemes;

const VISEME_WEIGHTS: Record<Viseme, number> = {
  sil: 0, PP: 0.8, FF: 0.5, TH: 0.45, DD: 0.4, kk: 0.4, CH: 0.5, SS: 0.4,
  nn: 0.35, RR: 0.45, aa: 0.7, E: 0.55, I: 0.5, O: 0.65, U: 0.55,
};

const VALID_VISEMES = new Set(Object.keys(VISEME_WEIGHTS));

// Relative pause lengths, in the same units as viseme durations.
const WORD_GAP_UNITS = 0.15;
const COMMA_PAUSE_UNITS = 1.2;
const SENTENCE_PAUSE_UNITS = 1.8;

const DIGRAPHS: Record<string, Viseme[]> = {
  th: ["TH"], sh: ["CH"], ch: ["CH"], ph: ["FF"], ck: ["kk"], ng: ["nn"],
  qu: ["kk", "U"], wh: ["U"], ee: ["I"], oo: ["U"], ea: ["I"], ou: ["aa", "U"],
  ow: ["aa", "U"], ai: ["E"], ay: ["E"], oa: ["O"], oi: ["O", "I"], oy: ["O", "I"],
};

const LETTERS: Record<string, Viseme[]> = {
  a: ["aa"], e: ["E"], i: ["I"], o: ["O"], u: ["U"], y: ["I"],
  p: ["PP"], b: ["PP"], m: ["PP"], f: ["FF"], v: ["FF"],
  t: ["DD"], d: ["DD"], k: ["kk"], g: ["kk"], c: ["kk"], q: ["kk"], x: ["kk", "SS"],
  s: ["SS"], z: ["SS"], j: ["CH"], n: ["nn"], l: ["nn"], r: ["RR"], w: ["U"],
  h: [],
};

const DIGIT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

const isVowelViseme = (v: Viseme) => v === "aa" || v === "E" || v === "I" || v === "O" || v === "U";

/** Simple grapheme → viseme rules for English, used when no richer converter is supplied. */
export function defaultWordToVisemes(word: string): WordVisemes {
  let w = word.toLowerCase().replace(/\d/g, (d) => DIGIT_WORDS[Number(d)]).replace(/[^a-z]/g, "");
  // Silent trailing "e" (make, time, role).
  if (w.length > 3 && w.endsWith("e") && !/[aeiou]e$/.test(w)) w = w.slice(0, -1);

  const visemes: string[] = [];
  const durations: number[] = [];
  const push = (v: Viseme) => {
    const d = isVowelViseme(v) ? 1.0 : v === "PP" ? 1.0 : 0.75;
    if (visemes[visemes.length - 1] === v) {
      durations[durations.length - 1] += 0.5 * d;
    } else {
      visemes.push(v);
      durations.push(d);
    }
  };

  for (let i = 0; i < w.length; ) {
    const pair = w.slice(i, i + 2);
    if (pair.length === 2 && DIGRAPHS[pair]) {
      DIGRAPHS[pair].forEach(push);
      i += 2;
    } else {
      (LETTERS[w[i]] ?? []).forEach(push);
      i += 1;
    }
  }
  return { visemes, durations };
}

/**
 * Finds where speech starts/ends in a chunk by trimming leading/trailing
 * frames below a fraction of the chunk's peak RMS. Returns seconds.
 */
export function computeSpeechBounds(
  samples: Float32Array,
  sampleRate: number,
  { frameMs = 10, relativeThreshold = 0.08 } = {}
): { start: number; end: number } {
  const duration = samples.length / sampleRate;
  const envelope = computeEnvelope(samples, sampleRate, frameMs, false);
  let peak = 0;
  for (const v of envelope) peak = Math.max(peak, v);
  if (peak === 0) return { start: 0, end: duration };

  const threshold = peak * relativeThreshold;
  let first = 0;
  while (first < envelope.length && envelope[first] < threshold) first++;
  let last = envelope.length - 1;
  while (last > first && envelope[last] < threshold) last--;

  const frameS = frameMs / 1000;
  return { start: first * frameS, end: Math.min(duration, (last + 1) * frameS) };
}

/** RMS loudness per frame; normalized to the chunk peak (0..1) by default. */
export function computeEnvelope(
  samples: Float32Array,
  sampleRate: number,
  frameMs = 20,
  normalize = true
): Float32Array {
  const frameSize = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const frames = Math.ceil(samples.length / frameSize);
  const envelope = new Float32Array(frames);
  let peak = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const startIdx = f * frameSize;
    const endIdx = Math.min(samples.length, startIdx + frameSize);
    for (let i = startIdx; i < endIdx; i++) sum += samples[i] * samples[i];
    envelope[f] = Math.sqrt(sum / Math.max(1, endIdx - startIdx));
    peak = Math.max(peak, envelope[f]);
  }
  if (normalize && peak > 0) for (let f = 0; f < frames; f++) envelope[f] /= peak;
  return envelope;
}

type Token = { kind: "word"; text: string } | { kind: "pause"; units: number };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(/[\p{L}\p{N}'’]+|[.!?;:]+|[,—–-]/gu)) {
    const t = match[0];
    if (/^[\p{L}\p{N}]/u.test(t)) tokens.push({ kind: "word", text: t });
    else if (/[.!?;:]/.test(t)) tokens.push({ kind: "pause", units: SENTENCE_PAUSE_UNITS });
    else tokens.push({ kind: "pause", units: COMMA_PAUSE_UNITS });
  }
  // Trailing punctuation is already covered by trimmed end silence.
  while (tokens.length && tokens[tokens.length - 1].kind === "pause") tokens.pop();
  return tokens;
}

export interface TimelineOptions {
  /** Seconds where audible speech starts/ends in the chunk. */
  speechStart?: number;
  speechEnd?: number;
  wordToVisemes?: WordToVisemes;
}

/** Spreads the text's visemes across [speechStart, speechEnd] of a chunk. */
export function buildVisemeTimeline(
  text: string,
  duration: number,
  { speechStart = 0, speechEnd = duration, wordToVisemes = defaultWordToVisemes }: TimelineOptions = {}
): VisemeEvent[] {
  const tokens = tokenize(text);
  const span = speechEnd - speechStart;
  if (!tokens.length || span <= 0) return [];

  // First pass: lay everything out in relative units.
  type Raw = { viseme: Viseme; at: number; len: number };
  const raw: Raw[] = [];
  let units = 0;
  tokens.forEach((token, idx) => {
    if (token.kind === "pause") {
      units += token.units;
      return;
    }
    const { visemes, durations } = wordToVisemes(token.text);
    visemes.forEach((v, i) => {
      if (!VALID_VISEMES.has(v)) return;
      const len = durations[i] ?? 1;
      raw.push({ viseme: v as Viseme, at: units, len });
      units += len;
    });
    if (idx < tokens.length - 1) units += WORD_GAP_UNITS;
  });
  if (units === 0 || !raw.length) return [];

  // Second pass: scale relative units to the measured speech span.
  const scale = span / units;
  return raw
    .filter((r) => r.viseme !== "sil")
    .map((r) => ({
      viseme: r.viseme,
      start: speechStart + r.at * scale,
      end: speechStart + (r.at + r.len) * scale,
      weight: VISEME_WEIGHTS[r.viseme],
    }));
}

/** Returns the viseme active at time t (seconds into the chunk), if any. */
export function visemeAt(timeline: VisemeEvent[], t: number): VisemeEvent | null {
  let lo = 0;
  let hi = timeline.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = timeline[mid];
    if (t < e.start) hi = mid - 1;
    else if (t >= e.end) lo = mid + 1;
    else return e;
  }
  return null;
}
