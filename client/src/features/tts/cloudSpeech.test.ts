import { describe, expect, it, vi } from "vitest";
import { CloudSpeechClient, splitSentences, type DecodeAudio, type FetchAudio } from "./cloudSpeech";
import type { TTSAudioChunk } from "./ttsTypes";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Decoder that returns a loud 0.5 s clip so trimSilence keeps it intact. */
const decode: DecodeAudio = async () => ({ samples: new Float32Array(12_000).fill(0.5), sampleRate: 24_000 });

describe("splitSentences", () => {
  it("keeps one long-enough sentence whole", () => {
    expect(splitSentences("Tell me about a project you are proud of.")).toEqual(["Tell me about a project you are proud of."]);
  });

  it("splits on sentence ends and merges very short sentences forward", () => {
    const out = splitSentences(
      "Great. Thanks for that detailed answer about caching. Next question: how would you test that caching layer?"
    );
    expect(out).toEqual([
      "Great. Thanks for that detailed answer about caching.",
      "Next question: how would you test that caching layer?",
    ]);
  });

  it("folds a very short closing sentence into the previous piece", () => {
    expect(splitSentences("Thanks for that detailed answer about caching. Got it?")).toEqual([
      "Thanks for that detailed answer about caching. Got it?",
    ]);
  });

  it("splits a very long sentence at a comma or space", () => {
    const long = `${"word ".repeat(40).trim()}, and then ${"more ".repeat(40).trim()}.`;
    const out = splitSentences(long);
    expect(out.length).toBeGreaterThan(1);
    expect(out.every((p) => p.length <= 290)).toBe(true);
    expect(out.join(" ").replace(/\s+/g, " ")).toBe(long);
  });

  it("returns nothing for blank text", () => {
    expect(splitSentences("   ")).toEqual([]);
  });
});

describe("CloudSpeechClient", () => {
  const text = "This is the first sentence of the reply. This is the second sentence of the reply.";

  it("delivers decoded sentences in order even when later ones arrive first", async () => {
    const releases: Array<() => void> = [];
    const fetchAudio: FetchAudio = (t) =>
      new Promise((resolve) => {
        const idx = t.startsWith("This is the first") ? 0 : 1;
        releases[idx] = () => resolve(new ArrayBuffer(1));
      });
    const client = new CloudSpeechClient(fetchAudio, decode);
    const chunks: TTSAudioChunk[] = [];
    const done = client.synthesize(text, (c) => chunks.push(c));

    await tick();
    releases[1](); // the second sentence finishes first
    await tick();
    expect(chunks).toHaveLength(0); // still waiting for sentence 0
    releases[0]();
    await expect(done).resolves.toBe("completed");

    expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1]);
    expect(chunks[0].text).toMatch(/^This is the first/);
    expect(chunks[0].sampleRate).toBe(24_000);
    expect(chunks[0].duration).toBeCloseTo(0.5, 1);
    expect(chunks[0].audioData.byteLength).toBe(12_000 * 4);
  });

  it("requests at most three sentences ahead", async () => {
    const pending: Array<() => void> = [];
    const fetchAudio = vi.fn<FetchAudio>(() => new Promise((resolve) => pending.push(() => resolve(new ArrayBuffer(1)))));
    const client = new CloudSpeechClient(fetchAudio, decode);
    const sentences = Array.from({ length: 6 }, (_, i) => `This is sentence number ${i + 1} of the long reply.`).join(" ");
    const done = client.synthesize(sentences, () => undefined);
    await tick();
    expect(fetchAudio).toHaveBeenCalledTimes(3);
    pending[0]();
    await tick();
    expect(fetchAudio).toHaveBeenCalledTimes(4);
    pending.slice(1).forEach((release) => release());
    while (pending.length < 6) await tick(), pending.forEach((release) => release());
    await expect(done).resolves.toBe("completed");
  });

  it("resolves 'cancelled' and stops delivering when cancelled mid-flight", async () => {
    const fetchAudio: FetchAudio = (_t, signal) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    const client = new CloudSpeechClient(fetchAudio, decode);
    const onChunk = vi.fn();
    const done = client.synthesize(text, onChunk);
    await tick();
    client.cancel();
    await expect(done).resolves.toBe("cancelled");
    expect(onChunk).not.toHaveBeenCalled();
  });

  it("a new synthesize supersedes the previous one", async () => {
    const fetchAudio: FetchAudio = (t, signal) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        if (t.startsWith("Second")) resolve(new ArrayBuffer(1));
      });
    const client = new CloudSpeechClient(fetchAudio, decode);
    const first = client.synthesize("First reply that never finishes loading from the server.", vi.fn());
    const onChunk = vi.fn();
    const second = client.synthesize("Second reply that loads right away from the server.", onChunk);
    await expect(first).resolves.toBe("cancelled");
    await expect(second).resolves.toBe("completed");
    expect(onChunk).toHaveBeenCalledTimes(1);
  });

  it("rejects when a sentence fails, and stops fetching the rest", async () => {
    const fetchAudio = vi.fn<FetchAudio>(async (t) => {
      if (t.startsWith("This is the first")) throw new Error("network down");
      return new ArrayBuffer(1);
    });
    const client = new CloudSpeechClient(fetchAudio, decode);
    const onChunk = vi.fn();
    await expect(client.synthesize(text, onChunk)).rejects.toThrow("network down");
    expect(onChunk).not.toHaveBeenCalled();
  });
});
