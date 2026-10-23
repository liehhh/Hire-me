import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecognitionCallbacks } from "./useSpeechRecognition";

const api = vi.hoisted(() => ({ sttToken: vi.fn() }));
vi.mock("../api/interviewApi", () => ({ interviewApi: { sttToken: api.sttToken } }));

const { useDeepgramRecognition } = await import("./useDeepgramRecognition");

// --- browser fakes -----------------------------------------------------------------

class FakeSocket {
  static last: FakeSocket;
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  sent: unknown[] = [];
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols: string[]
  ) {
    FakeSocket.last = this;
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  say(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  get messages() {
    return this.sent.filter((s): s is string => typeof s === "string").map((s) => JSON.parse(s) as { type: string });
  }
  get audio() {
    return this.sent.filter((s): s is Int16Array => s instanceof Int16Array);
  }
}

class FakeNode {
  static last: FakeNode;
  port: { onmessage: ((e: { data: Float32Array }) => void) | null } = { onmessage: null };
  constructor() {
    FakeNode.last = this;
  }
  connect() {}
  disconnect() {}
  /** What the audio worklet posts: one block of samples. */
  frame(samples: Float32Array) {
    this.port.onmessage?.({ data: samples });
  }
}

class FakeContext {
  sampleRate = 48_000;
  destination = {};
  audioWorklet = { addModule: vi.fn(async () => undefined) };
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
  createGain() {
    return { gain: { value: 1 }, connect() {}, disconnect() {} };
  }
  async resume() {}
  async close() {}
}

const stopTrack = vi.fn();

function setup() {
  const callbacks = {
    onFinal: vi.fn(),
    onInterim: vi.fn(),
    onActivity: vi.fn(),
    onFatalError: vi.fn(),
    onUtteranceEnd: vi.fn(),
  } satisfies RecognitionCallbacks;
  const hook = renderHook(() => useDeepgramRecognition(callbacks));
  return { callbacks, ...hook };
}

/** Lets the hook get through getUserMedia, the worklet setup and the token request. */
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

beforeEach(() => {
  api.sttToken.mockReset();
  api.sttToken.mockResolvedValue({ token: "temp-token", model: "nova-3", expiresInSeconds: 120 });
  stopTrack.mockReset();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("AudioWorkletNode", FakeNode);
  URL.createObjectURL = vi.fn(() => "blob:worklet");
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useDeepgramRecognition", () => {
  it("opens the socket with the temporary token, and sends audio spoken while it was connecting", async () => {
    const { result } = setup();
    let started!: Promise<string>;
    act(() => {
      started = result.current.start();
    });
    await settle();

    const ws = FakeSocket.last;
    expect(ws.protocols).toEqual(["bearer", "temp-token"]);
    expect(ws.url).toContain("model=nova-3");
    expect(ws.url).toContain("sample_rate=48000");
    expect(ws.url).toContain("utterance_end_ms=2000");

    // The candidate starts talking before the socket is open: nothing may be lost.
    act(() => FakeNode.last.frame(new Float32Array(2_048).fill(0.5)));
    expect(ws.audio).toHaveLength(0);
    act(() => ws.open());
    expect(await started).toBe("listening");
    expect(ws.audio).toHaveLength(1);
    expect(ws.audio[0][0]).toBe(Math.trunc(0.5 * 0x7fff));
    await waitFor(() => expect(result.current.isListening).toBe(true));

    // Later audio goes straight out.
    act(() => FakeNode.last.frame(new Float32Array(2_048)));
    expect(ws.audio).toHaveLength(2);
  });

  it("turns Deepgram results into interim text, final chunks, activity and the end-of-utterance signal", async () => {
    const { result, callbacks } = setup();
    act(() => void result.current.start());
    await settle();
    const ws = FakeSocket.last;
    act(() => ws.open());
    await settle();

    const results = (transcript: string, is_final: boolean) => ({
      type: "Results",
      is_final,
      channel: { alternatives: [{ transcript }] },
    });
    act(() => ws.say(results("so I would", false)));
    expect(callbacks.onInterim).toHaveBeenLastCalledWith("so I would");
    expect(callbacks.onActivity).toHaveBeenCalled();

    act(() => ws.say(results("So I would use a queue.", true)));
    expect(callbacks.onFinal).toHaveBeenCalledWith("So I would use a queue.");
    expect(callbacks.onInterim).toHaveBeenLastCalledWith("");

    act(() => ws.say({ type: "UtteranceEnd" }));
    expect(callbacks.onUtteranceEnd).toHaveBeenCalledTimes(1);
  });

  it("flushes on stop: finalizes, waits for the last words, then closes the stream and the mic", async () => {
    const { result, callbacks } = setup();
    act(() => void result.current.start());
    await settle();
    const ws = FakeSocket.last;
    act(() => ws.open());
    await settle();
    act(() => ws.say({ type: "Results", is_final: false, channel: { alternatives: [{ transcript: "and then" }] } }));

    let stopped = false;
    act(() => {
      void result.current.stopAndFlush().then(() => (stopped = true));
    });
    await settle();
    expect(ws.messages.map((m) => m.type)).toEqual(["Finalize"]);
    expect(stopped).toBe(false); // still waiting for Deepgram's answer to the flush

    act(() =>
      ws.say({ type: "Results", is_final: true, from_finalize: true, channel: { alternatives: [{ transcript: "And then we retry." }] } })
    );
    await waitFor(() => expect(stopped).toBe(true));
    expect(callbacks.onFinal).toHaveBeenCalledWith("And then we retry.");
    expect(ws.messages.map((m) => m.type)).toEqual(["Finalize", "CloseStream"]);
    expect(stopTrack).toHaveBeenCalled();
    expect(result.current.isListening).toBe(false);
  });

  it("keeps words Deepgram never finalized when the flush times out", async () => {
    vi.useFakeTimers();
    try {
      const { result, callbacks } = setup();
      act(() => void result.current.start());
      await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
      const ws = FakeSocket.last;
      act(() => ws.open());
      await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
      act(() => ws.say({ type: "Results", is_final: false, channel: { alternatives: [{ transcript: "almost done" }] } }));

      let stopped = false;
      act(() => {
        void result.current.stopAndFlush().then(() => (stopped = true));
      });
      await act(async () => void (await vi.advanceTimersByTimeAsync(1_000)));
      expect(stopped).toBe(true);
      expect(callbacks.onFinal).toHaveBeenCalledWith("almost done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports unavailable (so another engine takes over) when no token can be had", async () => {
    api.sttToken.mockRejectedValue(new Error("502"));
    const { result } = setup();
    let outcome = "";
    await act(async () => {
      outcome = await result.current.start();
    });
    expect(outcome).toBe("unavailable");
    expect(result.current.isSupported).toBe(false);
    expect(stopTrack).toHaveBeenCalled(); // the mic is released again
  });

  it("does not fall back when the microphone is blocked: the candidate is told instead", async () => {
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("denied"));
    const { result, callbacks } = setup();
    let outcome = "";
    await act(async () => {
      outcome = await result.current.start();
    });
    expect(outcome).toBe("cancelled");
    expect(callbacks.onFatalError).toHaveBeenCalledWith(expect.stringContaining("Microphone access was blocked"));
    expect(result.current.isSupported).toBe(true);
  });
});
