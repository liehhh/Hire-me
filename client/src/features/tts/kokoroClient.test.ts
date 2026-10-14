import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireKokoroClient,
  KokoroClient,
  releaseKokoroClient,
  resetSharedKokoroClientForTests,
} from "./kokoroClient";
import type { TTSAudioChunk } from "./kokoroTypes";
import { createFakeEngine, fakeLoader, flush, InProcessWorker, last } from "./testUtils";

function setup(engine = createFakeEngine()) {
  const loader = fakeLoader(engine);
  let worker!: InProcessWorker;
  const client = new KokoroClient(() => (worker = new InProcessWorker(loader)));
  return { client, worker, loader };
}

describe("KokoroClient", () => {
  afterEach(() => vi.useRealTimers());

  it("dedupes concurrent model loads into one load-model request", async () => {
    const { client, worker, loader } = setup();
    await Promise.all([client.load("af_heart"), client.load("af_heart"), client.load("af_heart")]);
    await client.load("af_heart");
    expect(worker.received.filter((m) => m.type === "load-model")).toHaveLength(1);
    expect(loader.calls).toBe(1);
    expect(client.status).toMatchObject({ modelState: "ready", device: "wasm", progress: 100 });
  });

  it("delivers chunks and resolves completed", async () => {
    const { client } = setup();
    await client.load("af_heart");
    const chunks: TTSAudioChunk[] = [];
    const { done } = client.synthesize("Hello. Welcome.", { voice: "af_heart" }, (c) => chunks.push(c));
    await expect(done).resolves.toBe("completed");
    expect(chunks.map((c) => c.text)).toEqual(["Hello.", "Welcome."]);
    expect(new Float32Array(chunks[0].audioData).length).toBe(12000);
  });

  it("cancel resolves 'cancelled' and drops any late audio", async () => {
    const { client } = setup(createFakeEngine({ delayMs: 5 }));
    await client.load("af_heart");
    const onChunk = vi.fn();
    const { done } = client.synthesize("One. Two. Three.", { voice: "af_heart" }, onChunk);
    client.cancel();
    await expect(done).resolves.toBe("cancelled");
    await new Promise((r) => setTimeout(r, 40));
    expect(onChunk).not.toHaveBeenCalled();
  });

  it("a new synthesis supersedes the previous one", async () => {
    const { client } = setup(createFakeEngine({ delayMs: 5 }));
    await client.load("af_heart");
    const oldChunks = vi.fn();
    const first = client.synthesize("Old one. Old two. Old three.", { voice: "af_heart" }, oldChunks);
    const newChunks: TTSAudioChunk[] = [];
    const second = client.synthesize("New.", { voice: "af_heart" }, (c) => newChunks.push(c));
    await expect(first.done).resolves.toBe("cancelled");
    await expect(second.done).resolves.toBe("completed");
    expect(oldChunks).not.toHaveBeenCalled();
    expect(newChunks.map((c) => c.text)).toEqual(["New."]);
  });

  it("rejects a synthesis when the worker reports an error", async () => {
    const { client } = setup(createFakeEngine({ failOn: "bad" }));
    const { done } = client.synthesize("bad input.", { voice: "af_heart" }, () => {});
    await expect(done).rejects.toThrow("inference failed");
  });

  it("fails loading and pending work when the worker crashes", async () => {
    const { client, worker } = setup();
    const load = client.load("af_heart");
    worker.crash("worker script failed");
    await expect(load).rejects.toThrow("worker script failed");
    expect(client.status.modelState).toBe("error");
  });

  it("notifies subscribers of loading progress and readiness", async () => {
    const { client } = setup();
    const states: string[] = [];
    client.subscribe((s) => states.push(`${s.modelState}:${s.progress}`));
    await client.load("af_heart");
    await flush();
    expect(states[0]).toBe("idle:null");
    expect(states).toContain("loading:50");
    expect(last(states)).toBe("ready:100");
  });
});

describe("shared client lifecycle", () => {
  afterEach(() => resetSharedKokoroClientForTests());

  it("reuses one client across a Strict Mode style unmount/remount and disposes after the last release", () => {
    vi.useFakeTimers();
    const workers: InProcessWorker[] = [];
    const create = () => {
      const w = new InProcessWorker(fakeLoader());
      workers.push(w);
      return w;
    };

    const a = acquireKokoroClient(create);
    releaseKokoroClient(a); // Strict Mode cleanup
    const b = acquireKokoroClient(create); // Strict Mode re-run
    expect(b).toBe(a);
    expect(workers).toHaveLength(1);

    releaseKokoroClient(b);
    expect(workers[0].terminated).toBe(false);
    vi.advanceTimersByTime(2500);
    expect(workers[0].terminated).toBe(true);

    const c = acquireKokoroClient(create);
    expect(c).not.toBe(a);
    releaseKokoroClient(c);
    vi.advanceTimersByTime(2500);
  });
});
