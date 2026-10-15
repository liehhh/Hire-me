import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AvatarSpeechAdapter } from "../avatar/AvatarSpeechAdapter";
import { CloudSpeechClient, type FetchAudio } from "./cloudSpeech";
import { FakeAudioContext, SAMPLE_RATE, tone } from "./testUtils";
import { SPEECH_ERROR_MESSAGE, useSpeech, type UseSpeechOptions } from "./useSpeech";

/** A real CloudSpeechClient whose network and decoder are replaced: 0.5 s of audio per sentence. */
function setup(opts: { fetchAudio?: FetchAudio } = {}, extra: Partial<UseSpeechOptions> = {}) {
  const ctx = new FakeAudioContext();
  const fetchAudio = vi.fn<FetchAudio>(opts.fetchAudio ?? (async () => new ArrayBuffer(1)));
  const client = new CloudSpeechClient(fetchAudio, async () => ({ samples: tone(0.5), sampleRate: SAMPLE_RATE }));
  const avatar: AvatarSpeechAdapter = {
    speak: vi.fn(() => Promise.resolve()),
    stop: vi.fn(),
    cancel: vi.fn(),
  };
  const hook = renderHook(() =>
    useSpeech({ client, getAudioContext: () => ctx.asAudioContext(), avatar: { current: avatar }, ...extra })
  );
  return { ...hook, ctx, fetchAudio, avatar };
}

/** Waits until every scheduled chunk is queued, then plays the audio out. */
async function playOut(ctx: FakeAudioContext, chunks: number) {
  await waitFor(() => expect(ctx.sources.filter((s) => !s.stopped).length).toBe(chunks));
  act(() => ctx.advance(10));
}

const TWO = "Welcome in, thanks for joining me today. Tell me a little about yourself and your background.";

describe("useSpeech", () => {
  it("fetches speech on speak and plays audio with callbacks in order", async () => {
    const { result, ctx, fetchAudio, avatar, unmount } = setup();
    expect(fetchAudio).not.toHaveBeenCalled(); // nothing requested until needed

    const events: string[] = [];
    let promise!: Promise<string>;
    act(() => {
      promise = result.current.speak(TWO, {
        onGenerating: () => events.push("thinking"),
        onStart: () => events.push("speaking"),
        onEnd: () => events.push("idle"),
      });
    });

    await waitFor(() => expect(result.current.isSpeaking).toBe(true));
    await playOut(ctx, 2);

    await expect(promise).resolves.toBe("completed");
    expect(events).toEqual(["thinking", "speaking", "idle"]);
    await waitFor(() => expect(result.current.isSpeaking).toBe(false));
    expect(result.current.isGenerating).toBe(false);
    expect(fetchAudio).toHaveBeenCalledTimes(2);
    expect(avatar.speak).toHaveBeenCalledTimes(2);
    expect(vi.mocked(avatar.speak).mock.calls[0][1]).toMatchObject({
      text: "Welcome in, thanks for joining me today.",
      sampleRate: SAMPLE_RATE,
    });
    unmount();
  });

  it("a new response cancels the one in progress", async () => {
    const slow: FetchAudio = (t, signal) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        setTimeout(() => resolve(new ArrayBuffer(1)), t.startsWith("Old") ? 20 : 0);
      });
    const { result, ctx, avatar, unmount } = setup({ fetchAudio: slow });
    const first = { onCancel: vi.fn(), onEnd: vi.fn() };
    const second = { onEnd: vi.fn() };
    let p1!: Promise<string>;
    let p2!: Promise<string>;
    act(() => {
      p1 = result.current.speak("Old one is long enough to count as a sentence. Old two follows right after it.", first);
    });
    await waitFor(() => expect(result.current.isSpeaking).toBe(true));
    act(() => {
      p2 = result.current.speak("Newest question, please answer it with an example from work?", second);
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
      p = result.current.speak("Hello there, and welcome to your mock interview today.", { onCancel });
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
      p = result.current.speak("Hello there, and welcome to your mock interview today.", { onEnd });
    });
    await waitFor(() => expect(result.current.isSpeaking).toBe(true));
    act(() => result.current.stop());
    await expect(p).resolves.toBe("completed");
    expect(onEnd).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("surfaces a failed request with a retry, without any fallback voice", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result, unmount } = setup({
      fetchAudio: async () => {
        throw new Error("server unavailable");
      },
    });
    const onError = vi.fn();
    let p!: Promise<string>;
    act(() => {
      p = result.current.speak("This request will fail, as the server is down.", { onError });
    });
    await expect(p).resolves.toBe("error");
    await waitFor(() => expect(result.current.error).toBe(SPEECH_ERROR_MESSAGE));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "server unavailable" }));
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

  describe("with the browser voice available", () => {
    const utterances: Array<{ text: string; onstart?: () => void; onend?: () => void }> = [];

    const installBrowserVoice = () => {
      class Utterance {
        lang = "";
        volume = 1;
        voice = null;
        onstart: (() => void) | undefined;
        onend: (() => void) | undefined;
        onerror: (() => void) | undefined;
        constructor(public text: string) {
          utterances.push(this);
        }
      }
      const synth = { speak: vi.fn(), cancel: vi.fn(), getVoices: () => [] };
      vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
      Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
      return synth;
    };

    afterEach(() => {
      utterances.length = 0;
      vi.unstubAllGlobals();
      // @ts-expect-error cleanup of the test double
      delete window.speechSynthesis;
    });

    it("speaks the line with the browser voice when the cloud voice fails before any audio", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const synth = installBrowserVoice();
      const { result, unmount } = setup({
        fetchAudio: async () => {
          throw new Error("daily budget used up");
        },
      });
      const events: string[] = [];
      let p!: Promise<string>;
      act(() => {
        p = result.current.speak("Please tell me about a hard problem you solved recently.", {
          onStart: () => events.push("speaking"),
          onEnd: () => events.push("idle"),
          onError: () => events.push("error"),
        });
      });

      await waitFor(() => expect(synth.speak).toHaveBeenCalled());
      expect(result.current.error).toBeNull(); // not surfaced as a failure
      act(() => utterances[0].onstart?.());
      await waitFor(() => expect(result.current.isSpeaking).toBe(true));
      expect(result.current.usingBackupVoice).toBe(true);

      act(() => utterances[utterances.length - 1].onend?.());
      await expect(p).resolves.toBe("completed");
      expect(events).toEqual(["speaking", "idle"]);
      await waitFor(() => expect(result.current.isSpeaking).toBe(false));
      unmount();
    });

    it("stop() silences the browser voice too", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const synth = installBrowserVoice();
      const { result, unmount } = setup({
        fetchAudio: async () => {
          throw new Error("down");
        },
      });
      act(() => {
        void result.current.speak("Please tell me about a hard problem you solved recently.");
      });
      await waitFor(() => expect(synth.speak).toHaveBeenCalled());
      synth.cancel.mockClear();
      act(() => result.current.cancel());
      expect(synth.cancel).toHaveBeenCalled();
      unmount();
    });
  });

  it("cleans up on unmount: silences the audio and stops requesting more", async () => {
    const { result, ctx, unmount } = setup();
    const onStart = vi.fn();
    act(() => {
      void result.current.speak("Hello there, welcome. Still talking for a little while longer now.", { onStart });
    });
    await waitFor(() => expect(onStart).toHaveBeenCalled());

    unmount();
    expect(ctx.sources.every((s) => s.stopped)).toBe(true);
  });
});
