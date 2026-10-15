import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserVoiceAvailable, pickEnglishVoice, speakWithBrowserVoice } from "./browserVoice";

const voice = (name: string, lang: string) => ({ name, lang }) as SpeechSynthesisVoice;

/** Minimal speechSynthesis whose utterances are finished manually by the test. */
class FakeSynth {
  spoken: FakeUtterance[] = [];
  cancel = vi.fn();
  voices: SpeechSynthesisVoice[] = [];
  speak = (u: FakeUtterance) => void this.spoken.push(u);
  getVoices = () => this.voices;
}

class FakeUtterance {
  lang = "";
  volume = 1;
  voice: SpeechSynthesisVoice | null = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  constructor(public text: string) {}
}

let synth: FakeSynth;

beforeEach(() => {
  synth = new FakeSynth();
  vi.stubGlobal("speechSynthesis", synth);
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  // @ts-expect-error cleanup of the test double
  delete window.speechSynthesis;
});

describe("pickEnglishVoice", () => {
  it("prefers natural-sounding US English voices", () => {
    const picked = pickEnglishVoice([
      voice("Fred", "en-US"),
      voice("Daniel", "en-GB"),
      voice("Ava (Premium)", "en-US"),
      voice("Thomas", "fr-FR"),
    ]);
    expect(picked?.name).toBe("Ava (Premium)");
  });

  it("ignores non-English voices and returns null when there are none", () => {
    expect(pickEnglishVoice([voice("Thomas", "fr-FR")])).toBeNull();
    expect(pickEnglishVoice([])).toBeNull();
  });
});

describe("speakWithBrowserVoice", () => {
  const text = "This is the first sentence of the reply. This is the second sentence of the reply.";

  it("reports availability", () => {
    expect(browserVoiceAvailable()).toBe(true);
  });

  it("speaks sentence by sentence, starting once and ending after the last", () => {
    const cb = { volume: 0.8, onStart: vi.fn(), onEnd: vi.fn(), onError: vi.fn() };
    speakWithBrowserVoice(text, cb);
    expect(synth.spoken.map((u) => u.text)).toEqual([
      "This is the first sentence of the reply.",
      "This is the second sentence of the reply.",
    ]);
    expect(synth.spoken[0].volume).toBe(0.8);

    synth.spoken[0].onstart?.();
    expect(cb.onStart).toHaveBeenCalledTimes(1);
    synth.spoken[1].onend?.();
    expect(cb.onEnd).toHaveBeenCalledTimes(1);
  });

  it("cancel() silences it and suppresses callbacks", () => {
    const cb = { volume: 1, onStart: vi.fn(), onEnd: vi.fn(), onError: vi.fn() };
    const handle = speakWithBrowserVoice(text, cb);
    handle.cancel();
    synth.spoken[0].onstart?.();
    synth.spoken[1].onend?.();
    expect(cb.onStart).not.toHaveBeenCalled();
    expect(cb.onEnd).not.toHaveBeenCalled();
    expect(synth.cancel).toHaveBeenCalled();
  });

  it("reports a real failure but ignores the cancellation echo", () => {
    const cb = { volume: 1, onStart: vi.fn(), onEnd: vi.fn(), onError: vi.fn() };
    speakWithBrowserVoice(text, cb);
    synth.spoken[0].onerror?.({ error: "interrupted" });
    expect(cb.onError).not.toHaveBeenCalled();
    synth.spoken[0].onerror?.({ error: "synthesis-failed" });
    expect(cb.onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("synthesis-failed") }));
  });
});
