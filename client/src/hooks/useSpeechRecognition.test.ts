import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSpeechRecognition, type RecognitionCallbacks } from "./useSpeechRecognition";

/** Minimal stand-in for the browser's SpeechRecognition. */
class FakeRecognition {
  static instances: FakeRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  running = false;
  starts = 0;
  results: { transcript: string; isFinal: boolean }[] = [];

  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() {
    if (this.running) throw new Error("already started");
    this.running = true;
    this.starts++;
    this.results = [];
  }
  stop() {
    // Real browsers finalize pending speech, then fire onend asynchronously.
    setTimeout(() => {
      this.emit(this.results.length, { transcript: " and that's it", isFinal: true });
      this.end();
    }, 300);
  }
  abort() {
    this.running = false;
  }
  /** Updates result `index` and fires onresult from there. */
  emit(index: number, result: { transcript: string; isFinal: boolean }) {
    this.results[index] = result;
    const results = this.results.map((r) =>
      Object.assign([{ transcript: r.transcript }], { isFinal: r.isFinal })
    );
    this.onresult?.({ resultIndex: index, results });
  }
  end() {
    this.running = false;
    this.onend?.();
  }
}

function setup() {
  const finals: string[] = [];
  let interim = "";
  const callbacks: RecognitionCallbacks = {
    onFinal: (t) => finals.push(t),
    onInterim: (t) => (interim = t),
    onActivity: vi.fn(),
    onFatalError: vi.fn(),
  };
  const hook = renderHook(() => useSpeechRecognition(callbacks));
  return { hook, finals, callbacks, interim: () => interim };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeRecognition.instances = [];
  (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeRecognition;
});
afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
});

describe("useSpeechRecognition", () => {
  it("does nothing until started", () => {
    setup();
    expect(FakeRecognition.instances).toHaveLength(0);
  });

  it("7: an unexpected browser onend keeps interim words and restarts instead of ending the answer", () => {
    const { hook, finals, interim } = setup();
    act(() => hook.result.current.start());
    const rec = FakeRecognition.instances[0];
    act(() => rec.emit(0, { transcript: "I designed the API", isFinal: true }));
    act(() => rec.emit(1, { transcript: "and then we", isFinal: false }));
    expect(interim()).toBe("and then we");

    act(() => rec.end()); // browser ended the session on its own
    expect(finals).toEqual(["I designed the API", "and then we"]);
    expect(interim()).toBe("");
    act(() => vi.advanceTimersByTime(300));
    expect(rec.starts).toBe(2); // restarted, same turn

    // New session: indexes restart at 0 and are not mistaken for duplicates.
    act(() => rec.emit(0, { transcript: "added caching", isFinal: true }));
    expect(finals[finals.length - 1]).toBe("added caching");
  });

  it("emits each final result index only once per session", () => {
    const { hook, finals } = setup();
    act(() => hook.result.current.start());
    const rec = FakeRecognition.instances[0];
    act(() => rec.emit(0, { transcript: "hello there", isFinal: true }));
    // Browser re-sends the whole list from index 0.
    act(() => rec.onresult?.({ resultIndex: 0, results: rec.results.map((r) => Object.assign([{ transcript: r.transcript }], { isFinal: r.isFinal })) }));
    expect(finals).toEqual(["hello there"]);
  });

  it("stopAndFlush waits for the browser's last final result before resolving, and does not restart", async () => {
    const { hook, finals } = setup();
    act(() => hook.result.current.start());
    const rec = FakeRecognition.instances[0];
    act(() => rec.emit(0, { transcript: "My answer", isFinal: true }));

    let done = false;
    let flush!: Promise<void>;
    act(() => {
      flush = hook.result.current.stopAndFlush().then(() => {
        done = true;
      });
    });
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(done).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(300));
    await flush;
    expect(finals).toEqual(["My answer", "and that's it"]);
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(rec.starts).toBe(1);
  });

  it("reports a blocked microphone without restarting", () => {
    const { hook, callbacks } = setup();
    act(() => hook.result.current.start());
    const rec = FakeRecognition.instances[0];
    act(() => {
      rec.onerror?.({ error: "not-allowed" });
      rec.end();
    });
    act(() => vi.advanceTimersByTime(5_000));
    expect(callbacks.onFatalError).toHaveBeenCalledTimes(1);
    expect(rec.starts).toBe(1);
  });
});
