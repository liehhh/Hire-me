import { describe, expect, it } from "vitest";
import type { TTSWorkerResponse } from "./kokoroTypes";
import { createKokoroWorkerHandler, createProgressAggregator, trimSilence } from "./kokoroWorkerCore";
import { createFakeEngine, fakeLoader, last } from "./testUtils";

function setup(engine = createFakeEngine()) {
  const posted: TTSWorkerResponse[] = [];
  const loader = fakeLoader(engine);
  const handle = createKokoroWorkerHandler(loader, (m) => posted.push(m));
  return { posted, loader, handle };
}

describe("kokoro worker core", () => {
  it("loads the model and reports progress then ready", async () => {
    const { posted, handle } = setup();
    await handle({ type: "load-model", voice: "af_heart" });
    expect(posted.map((m) => m.type)).toEqual(["loading", "loading", "loading", "ready"]);
    expect(last(posted)).toEqual({ type: "ready", device: "wasm" });
  });

  it("never initializes the model twice", async () => {
    const { loader, handle } = setup();
    await Promise.all([
      handle({ type: "load-model", voice: "af_heart" }),
      handle({ type: "load-model", voice: "af_heart" }),
      handle({ type: "synthesize", requestId: 1, text: "Hello.", voice: "af_heart" }),
    ]);
    await handle({ type: "load-model", voice: "af_heart" });
    expect(loader.calls).toBe(1);
  });

  it("synthesizes one audio message per sentence, then done", async () => {
    const { posted, handle } = setup();
    await handle({ type: "synthesize", requestId: 7, text: "Hi there. Tell me about you?", voice: "af_heart", speed: 0.95 });
    const audio = posted.filter((m) => m.type === "audio");
    expect(audio).toHaveLength(2);
    expect(audio[0]).toMatchObject({ requestId: 7, chunkIndex: 0, text: "Hi there.", sampleRate: 24000, duration: 0.5 });
    expect(audio[1]).toMatchObject({ chunkIndex: 1, text: "Tell me about you?" });
    expect(last(posted)).toEqual({ type: "done", requestId: 7 });
  });

  it("stops producing audio after cancel", async () => {
    const { posted, handle } = setup();
    await handle({ type: "load-model", voice: "af_heart" });
    const run = handle({ type: "synthesize", requestId: 1, text: "One. Two. Three. Four.", voice: "af_heart" });
    await handle({ type: "cancel" });
    await run;
    expect(posted.filter((m) => m.type === "audio").length).toBeLessThan(4);
    expect(posted.some((m) => m.type === "done")).toBe(false);
  });

  it("lets a newer request supersede an older one", async () => {
    const { posted, handle } = setup();
    await handle({ type: "load-model", voice: "af_heart" });
    const first = handle({ type: "synthesize", requestId: 1, text: "One. Two. Three. Four.", voice: "af_heart" });
    const second = handle({ type: "synthesize", requestId: 2, text: "Newest.", voice: "af_heart" });
    await Promise.all([first, second]);
    const done = posted.filter((m) => m.type === "done");
    expect(done).toEqual([{ type: "done", requestId: 2 }]);
    const lastAudio = last(posted.filter((m) => m.type === "audio"));
    expect(lastAudio).toMatchObject({ requestId: 2, text: "Newest." });
  });

  it("reports generation errors with the requestId", async () => {
    const { posted, handle } = setup(createFakeEngine({ failOn: "boom" }));
    await handle({ type: "synthesize", requestId: 3, text: "Fine. boom.", voice: "af_heart" });
    expect(last(posted)).toEqual({ type: "error", requestId: 3, message: "inference failed" });
  });

  it("reports load errors and allows a retry", async () => {
    const posted: TTSWorkerResponse[] = [];
    let attempts = 0;
    const handle = createKokoroWorkerHandler(async () => {
      if (attempts++ === 0) throw new Error("network down");
      return { engine: createFakeEngine(), device: "webgpu" };
    }, (m) => posted.push(m));

    await handle({ type: "load-model", voice: "af_heart" });
    expect(last(posted)).toEqual({ type: "error", message: "network down" });
    await handle({ type: "load-model", voice: "af_heart" });
    expect(last(posted)).toEqual({ type: "ready", device: "webgpu" });
  });
});

describe("createProgressAggregator", () => {
  it("combines per-file progress into one percentage", () => {
    const values: number[] = [];
    const onInfo = createProgressAggregator((p) => values.push(p));
    onInfo({ status: "initiate", file: "a" });
    onInfo({ status: "progress", file: "model.onnx", loaded: 50, total: 100 });
    onInfo({ status: "progress", file: "tokenizer.json", loaded: 0, total: 100 });
    onInfo({ status: "progress", file: "tokenizer.json", loaded: 100, total: 100 });
    onInfo({ status: "progress", file: "model.onnx", loaded: 100, total: 100 });
    expect(values).toEqual([50, 25, 75, 100]);
  });
});

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
