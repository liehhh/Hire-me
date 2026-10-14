import { describe, expect, it, vi } from "vitest";
import { SpeechPlayer, unlockAudio } from "./audioPlayback";
import { FakeAudioContext, tone } from "./testUtils";

function setup() {
  const ctx = new FakeAudioContext();
  const player = new SpeechPlayer(() => ctx.asAudioContext());
  return { ctx, player };
}

describe("SpeechPlayer", () => {
  it("schedules chunks back-to-back and tracks duration", () => {
    const { player } = setup();
    player.begin(1, {});
    const a = player.enqueue(tone(0.5), 24000)!;
    const b = player.enqueue(tone(0.25), 24000)!;
    expect(a.startAt).toBeCloseTo(0.05);
    expect(b.startAt).toBeCloseTo(0.55);
    expect(player.duration).toBeCloseTo(0.75);
  });

  it("fires onStart once and onEnd after the last chunk drains", () => {
    const { ctx, player } = setup();
    const onStart = vi.fn();
    const onEnd = vi.fn();
    player.begin(1, { onStart, onEnd });
    player.enqueue(tone(0.5), 24000);
    player.enqueue(tone(0.5), 24000);
    expect(onStart).toHaveBeenCalledTimes(1);

    ctx.advance(0.6); // first chunk done, finish() not yet called
    player.finish();
    expect(onEnd).not.toHaveBeenCalled();
    ctx.advance(0.5);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(player.state).toBe("idle");
  });

  it("stop() silences playback without calling onEnd", () => {
    const { ctx, player } = setup();
    const onEnd = vi.fn();
    player.begin(1, { onEnd });
    player.enqueue(tone(0.5), 24000);
    player.finish();
    player.stop();
    expect(ctx.sources.every((s) => s.stopped)).toBe(true);
    ctx.advance(1);
    expect(onEnd).not.toHaveBeenCalled();
    expect(player.state).toBe("idle");
  });

  it("begin() replaces the previous utterance", () => {
    const { ctx, player } = setup();
    const firstEnd = vi.fn();
    const secondEnd = vi.fn();
    player.begin(1, { onEnd: firstEnd });
    player.enqueue(tone(1), 24000);
    player.begin(1, { onEnd: secondEnd });
    player.enqueue(tone(0.2), 24000);
    player.finish();
    ctx.advance(2);
    expect(firstEnd).not.toHaveBeenCalled();
    expect(secondEnd).toHaveBeenCalledTimes(1);
  });

  it("pauses and resumes via the audio clock", async () => {
    const { ctx, player } = setup();
    player.begin(1, {});
    player.enqueue(tone(1), 24000);
    await player.pause();
    expect(ctx.state).toBe("suspended");
    expect(player.state).toBe("paused");
    await player.resume();
    expect(ctx.state).toBe("running");
    expect(player.state).toBe("playing");
  });

  it("reports elapsed playback time", () => {
    const { ctx, player } = setup();
    player.begin(1, {});
    player.enqueue(tone(1), 24000);
    ctx.advance(0.55);
    expect(player.elapsed).toBeCloseTo(0.5);
  });
});

describe("unlockAudio", () => {
  it("resumes a suspended context", async () => {
    const ctx = new FakeAudioContext();
    ctx.state = "suspended";
    await expect(unlockAudio(() => ctx.asAudioContext())).resolves.toBe(true);
  });

  it("returns false when the browser keeps audio blocked", async () => {
    const ctx = new FakeAudioContext();
    ctx.state = "suspended";
    ctx.resume = () => new Promise(() => {}); // pending until a user gesture
    await expect(unlockAudio(() => ctx.asAudioContext(), 10)).resolves.toBe(false);
  });
});
