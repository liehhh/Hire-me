import { describe, expect, it } from "vitest";
import {
  buildVisemeTimeline,
  computeEnvelope,
  computeSpeechBounds,
  defaultWordToVisemes,
  visemeAt,
} from "./visemeTiming";
import { last } from "./testUtils";

describe("defaultWordToVisemes", () => {
  it("maps graphemes to Oculus visemes", () => {
    expect(defaultWordToVisemes("mama").visemes).toEqual(["PP", "aa", "PP", "aa"]);
    expect(defaultWordToVisemes("think").visemes).toEqual(["TH", "I", "nn", "kk"]);
    // silent trailing e
    expect(defaultWordToVisemes("role").visemes).toEqual(["RR", "O", "nn"]);
  });

  it("spells out digits", () => {
    expect(defaultWordToVisemes("5").visemes.length).toBeGreaterThan(0);
  });
});

describe("buildVisemeTimeline", () => {
  it("is deterministic and fits inside the speech span", () => {
    const text = "Tell me about a project you led.";
    const a = buildVisemeTimeline(text, 2, { speechStart: 0.1, speechEnd: 1.8 });
    const b = buildVisemeTimeline(text, 2, { speechStart: 0.1, speechEnd: 1.8 });
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(10);
    expect(a[0].start).toBeCloseTo(0.1);
    expect(last(a)!.end).toBeCloseTo(1.8);
    for (let i = 1; i < a.length; i++) expect(a[i].start).toBeGreaterThanOrEqual(a[i - 1].end - 1e-9);
  });

  it("scales with audio duration", () => {
    const short = buildVisemeTimeline("Hello there", 1);
    const long = buildVisemeTimeline("Hello there", 2);
    expect(last(long)!.end).toBeCloseTo(2 * last(short)!.end);
  });

  it("leaves a gap for commas", () => {
    const timeline = buildVisemeTimeline("Yes, okay", 1);
    const gaps = timeline.slice(1).map((e, i) => e.start - timeline[i].end);
    expect(Math.max(...gaps)).toBeGreaterThan(0.05);
  });

  it("uses a custom word converter when given", () => {
    const timeline = buildVisemeTimeline("anything", 1, {
      wordToVisemes: () => ({ visemes: ["O", "bogus", "PP"], durations: [1, 1, 1] }),
    });
    expect(timeline.map((e) => e.viseme)).toEqual(["O", "PP"]);
  });

  it("returns nothing for empty text", () => {
    expect(buildVisemeTimeline("  ...  ", 1)).toEqual([]);
  });
});

describe("visemeAt", () => {
  it("finds the active viseme by time", () => {
    const timeline = buildVisemeTimeline("Hi", 1);
    expect(visemeAt(timeline, timeline[0].start)?.viseme).toBe(timeline[0].viseme);
    expect(visemeAt(timeline, 5)).toBeNull();
  });
});

describe("audio analysis", () => {
  const sr = 1000;
  // 0.2s silence, 0.5s loud, 0.3s silence
  const samples = new Float32Array(1000);
  for (let i = 200; i < 700; i++) samples[i] = i % 2 ? 0.5 : -0.5;

  it("computeSpeechBounds trims leading/trailing silence", () => {
    const { start, end } = computeSpeechBounds(samples, sr);
    expect(start).toBeCloseTo(0.2, 1);
    expect(end).toBeCloseTo(0.7, 1);
  });

  it("computeEnvelope is normalized and zero during silence", () => {
    const env = computeEnvelope(samples, sr, 100);
    expect(env[0]).toBe(0);
    expect(Math.max(...env)).toBe(1);
    expect(env[9]).toBe(0);
  });
});
