import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AvatarSpeechAdapter } from "../avatar/AvatarSpeechAdapter";
import { resetSharedKokoroClientForTests } from "./kokoroClient";
import { createFakeEngine, FakeAudioContext, fakeLoader, InProcessWorker } from "./testUtils";
import { TTS_ERROR_MESSAGE, useKokoroTTS, type UseKokoroTTSOptions } from "./useKokoroTTS";

function setup(engine = createFakeEngine(), extra: Partial<UseKokoroTTSOptions> = {}) {
  const ctx = new FakeAudioContext();
  const workers: InProcessWorker[] = [];
  const avatar: AvatarSpeechAdapter = {
    speak: vi.fn(() => Promise.resolve()),
    stop: vi.fn(),
    cancel: vi.fn(),
  };
  const hook = renderHook(() =>
    useKokoroTTS({
      createWorker: () => {
        const w = new InProcessWorker(fakeLoader(engine));
        workers.push(w);
        return w;
      },
      getAudioContext: () => ctx.asAudioContext(),
      avatar: { current: avatar },
      ...extra,
    })
  );
  return { ...hook, ctx, workers, avatar };
}

/** Waits until every scheduled chunk is queued, then plays the audio out. */
async function playOut(ctx: FakeAudioContext, chunks: number) {
  await waitFor(() => expect(ctx.sources.filter((s) => !s.stopped).length).toBe(chunks));
  act(() => ctx.advance(10));
}

describe("useKokoroTTS", () => {
  afterEach(() => resetSharedKokoroClientForTests());

  it("loads the model lazily on first speak and plays audio with callbacks in order", async () => {
    const onModelReady = vi.fn();
    const { result, ctx, workers, avatar, unmount } = setup(createFakeEngine(), { onModelReady });
    expect(result.current.isReady).toBe(false);
    expect(workers[0].received).toEqual([]); // nothing loaded until needed

    const events: string[] = [];
    let promise!: Promise<string>;
    act(() => {
      promise = result.current.speak("Welcome in. Tell me about yourself.", {
        onGenerating: () => events.push("thinking"),
        onStart: () => events.push("speaking"),
        onEnd: () => events.push("idle"),
      });
    });

    await waitFor(() => expect(result.current.isSpeaking).toBe(true));
    expect(result.current.isReady).toBe(true);
    expect(onModelReady).toHaveBeenCalledTimes(1);
    await playOut(ctx, 2);

    await expect(promise).resolves.toBe("completed");
    expect(events).toEqual(["thinking", "speaking", "idle"]);
    await waitFor(() => expect(result.current.isSpeaking).toBe(false));
    expect(result.current.isGenerating).toBe(false);
    expect(avatar.speak).toHaveBeenCalledTimes(2);
    expect(vi.mocked(avatar.speak).mock.calls[0][1]).toMatchObject({ text: "Welcome in.", sampleRate: 24000 });
    unmount();
  });

  it("does not reload the model for later responses", async () => {
    const { result, ctx, workers, unmount } = setup();
    for (const text of ["First.", "Second."]) {
      let p!: Promise<string>;
      act(() => {
        p = result.current.speak(text);
      });
      await playOut(ctx, 1);
      await p;
      ctx.sources = [];
    }
    expect(workers[0].received.filter((m) => m.type === "load-model")).toHaveLength(1);
    unmount();
  });

  it("a new response cancels the one in progress", async () => {
    const { result, ctx, avatar, unmount } = setup(createFakeEngine({ delayMs: 5 }));
    const first = { onCancel: vi.fn(), onEnd: vi.fn() };
    const second = { onEnd: vi.fn() };
    let p1!: Promise<string>;
    let p2!: Promise<string>;
    act(() => {
      p1 = result.current.speak("Old one. Old two. Old three.", first);
    });
    await waitFor(() => expect(result.current.isSpeaking).toBe(true));
    act(() => {
      p2 = result.current.speak("Newest question?", second);
    });

    await expect(p1).resolves.toBe("cancelled");
    expect(first.onCancel).toHaveBeenCalledTimes(1);
    expect(avatar.cancel).toHaveBeenCalled();
    expect(ctx.sources[0].stopped).toBe(true); // old audio silenced

    await waitFor(() => expect(result.current.isSpeaking).toBe(true));
    act(() => ctx.advance(10));
    await expect(p2).resolves.toBe("completed");
    expect(second.onEnd).toHaveBeenCalledTimes(1);
    expect(first.onEnd).not.toHaveBeenCalled();
    unmount();
  });

  it("cancel() stops playback and fires onCancel", async () => {
    const { result, ctx, unmount } = setup();
    const onCancel = vi.fn();
    let p!: Promise<string>;
    act(() => {
      p = result.current.speak("Hello there.", { onCancel });
    });
    await waitFor(() => expect(result.current.isSpeaking).toBe(true));
    act(() => result.current.cancel());
    await expect(p).resolves.toBe("cancelled");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(ctx.sources.every((s) => s.stopped)).toBe(true);
    await waitFor(() => expect(result.current.isSpeaking).toBe(false));
    unmount();
  });

  it("stop() ends the current speech and fires onEnd", async () => {
    const { result, unmount } = setup();
    const onEnd = vi.fn();
    let p!: Promise<string>;
    act(() => {
      p = result.current.speak("Hello there.", { onEnd });
    });
    await waitFor(() => expect(result.current.isSpeaking).toBe(true));
    act(() => result.current.stop());
    await expect(p).resolves.toBe("completed");
    expect(onEnd).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("surfaces worker errors with a retry, without any fallback voice", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result, unmount } = setup(createFakeEngine({ failOn: "fail" }));
    const onError = vi.fn();
    let p!: Promise<string>;
    act(() => {
      p = result.current.speak("This will fail.", { onError });
    });
    await expect(p).resolves.toBe("error");
    await waitFor(() => expect(result.current.error).toBe(TTS_ERROR_MESSAGE));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "inference failed" }));
    expect(result.current.isSpeaking).toBe(false);
    expect(consoleSpy).toHaveBeenCalled(); // technical detail logged in dev only

    let retried!: Promise<string>;
    act(() => {
      retried = result.current.retry();
    });
    await expect(retried).resolves.toBe("error"); // same text, same failure
    consoleSpy.mockRestore();
    unmount();
  });

  it("cleans up on unmount: cancels audio and terminates the worker", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result, ctx, workers, unmount } = setup();
    const onStart = vi.fn();
    act(() => {
      void result.current.speak("Hello there. Still talking.", { onStart });
    });
    await waitFor(() => expect(onStart).toHaveBeenCalled());

    unmount();
    expect(ctx.sources.every((s) => s.stopped)).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(workers[0].terminated).toBe(true);
    vi.useRealTimers();
  });
});
