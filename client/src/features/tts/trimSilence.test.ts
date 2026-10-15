import { describe, expect, it } from "vitest";
import { trimSilence } from "./trimSilence";

describe("trimSilence", () => {
  it("cuts long silent padding down to a short margin", () => {
    const rate = 24000;
    const samples = new Float32Array(rate * 2); // 1 s silence, 0.5 s voice, 0.5 s silence
    for (let i = rate; i < rate * 1.5; i++) samples[i] = 0.5;
    const trimmed = trimSilence(samples, rate);
    expect(trimmed.length / rate).toBeCloseTo(0.5 + 0.03 + 0.12, 2);
  });

  it("leaves all-silent audio untouched", () => {
    expect(trimSilence(new Float32Array(100), 24000).length).toBe(100);
  });
});
