import { describe, expect, it } from "vitest";
import { PrebufferGate } from "./prebufferGate";

/** Sentence of `chars` characters producing `seconds` of audio. */
const SENTENCE = { chars: 50, seconds: 3 };

function gateWithClock(totalSentences: number) {
  let t = 0;
  const gate = new PrebufferGate(SENTENCE.chars * totalSentences, () => t);
  return { gate, advance: (ms: number) => (t += ms) };
}

describe("PrebufferGate", () => {
  it("starts on the first sentence when generation is faster than real time", () => {
    const { gate, advance } = gateWithClock(4);
    advance(1_000); // 3 s of audio in 1 s
    expect(gate.add(SENTENCE.chars, SENTENCE.seconds)).toBe(true);
  });

  it("holds playback on a slow device until the rest can be generated without gaps", () => {
    const { gate, advance } = gateWithClock(4);
    advance(4_500); // 3 s of audio in 4.5 s: 1.5x slower than real time
    expect(gate.add(SENTENCE.chars, SENTENCE.seconds)).toBe(false);
    advance(4_500);
    expect(gate.add(SENTENCE.chars, SENTENCE.seconds)).toBe(false);
    advance(4_500);
    // 9 s buffered; the last 3 s take 4.5 s to generate — no gap.
    expect(gate.add(SENTENCE.chars, SENTENCE.seconds)).toBe(true);
  });

  it("always releases once the whole text is generated", () => {
    const { gate, advance } = gateWithClock(1);
    advance(60_000);
    expect(gate.add(SENTENCE.chars, SENTENCE.seconds)).toBe(true);
  });
});
