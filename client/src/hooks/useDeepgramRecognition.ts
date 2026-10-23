import { useCallback, useEffect, useRef, useState } from "react";
import { interviewApi } from "../api/interviewApi";
import type { RecognitionCallbacks } from "./useSpeechRecognition";

// Streaming speech-to-text with Deepgram. The microphone is streamed straight
// to Deepgram over a WebSocket, authenticated with a short-lived token minted
// by our server (the API key itself never reaches the browser). Compared with
// the browser's built-in recognition it is accurate on technical vocabulary,
// behaves the same in every browser, and tells us when the speaker has really
// stopped (UtteranceEnd), so the answer can be submitted without a long wait.
//
// Like the other engines it only runs between start() and stopAndFlush()/abort()
// and reports through the shared RecognitionCallbacks.

/** Longest we wait for Deepgram to return the last words after the answer ends. */
const FLUSH_TIMEOUT_MS = 900;
/** Longest we wait for the socket to open before giving up on Deepgram for this turn. */
const OPEN_TIMEOUT_MS = 4_000;
/** If the answer ends while the socket is still opening, wait this long for it before dropping the audio. */
const LATE_OPEN_GRACE_MS = 1_500;
/** Stop reusing a token this close to its expiry. */
const TOKEN_SAFETY_MS = 10_000;
/** ~40 ms of audio per message at 48 kHz. */
const SEND_BATCH_SAMPLES = 2_048;
/** The speaker is considered done after this much silence (Deepgram's minimum is 1000). */
const UTTERANCE_END_MS = 2_000;
const MAX_RECONNECTS = 2;

const MIC_BLOCKED = "Microphone access was blocked. Allow it in the browser, or type your answer.";
const CONNECTION_LOST = "Voice input lost its connection. Type your answer instead.";

const WORKLET_SOURCE = `
class PcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
`;

export type DeepgramStart = "listening" | "unavailable" | "cancelled";

interface Token {
  token: string;
  model: string;
  expiresAt: number;
}

interface Session {
  gen: number;
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  node: AudioWorkletNode;
  sink: GainNode;
  socket: WebSocket | null;
  /** Audio captured while there is no open socket (connecting, reconnecting). */
  queue: Int16Array[];
  /** Float samples not yet sent as a full batch. */
  pending: Float32Array[];
  pendingSamples: number;
  /** Resolves true when the current socket is open. */
  opening: Promise<boolean>;
  /** Not yet finalized text from the current utterance. */
  interim: string;
  /** Resolved when Deepgram answers a Finalize request. */
  finalized: (() => void) | null;
  reconnects: number;
  /** The answer ended; we are collecting the last words. */
  ending: boolean;
  captureClosed: boolean;
  closedByUs: boolean;
}

let workletUrl: string | null = null;
const getWorkletUrl = () => (workletUrl ??= URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" })));

const canStream = () =>
  typeof window !== "undefined" &&
  typeof WebSocket !== "undefined" &&
  typeof AudioWorkletNode !== "undefined" &&
  !!navigator.mediaDevices?.getUserMedia;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function toInt16(parts: Float32Array[], total: number): Int16Array {
  const out = new Int16Array(total);
  let i = 0;
  for (const part of parts) {
    for (let j = 0; j < part.length; j++) {
      const v = Math.max(-1, Math.min(1, part[j]));
      out[i++] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
  }
  return out;
}

export function useDeepgramRecognition(callbacks: RecognitionCallbacks) {
  const [capable] = useState(canStream);
  /** Set once Deepgram could not be used (no token, no connection); the caller falls back to another engine. */
  const [failed, setFailed] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const sessionRef = useRef<Session | null>(null);
  /** Bumped on every start/stop so a late getUserMedia or socket can't revive a closed turn. */
  const genRef = useRef(0);
  const tokenRef = useRef<Token | null>(null);
  const tokenFetchRef = useRef<Promise<Token> | null>(null);

  const getToken = useCallback((): Promise<Token> => {
    const cached = tokenRef.current;
    if (cached && cached.expiresAt - Date.now() > TOKEN_SAFETY_MS) return Promise.resolve(cached);
    tokenFetchRef.current ??= interviewApi
      .sttToken()
      .then((res) => {
        const token = { token: res.token, model: res.model, expiresAt: Date.now() + res.expiresInSeconds * 1000 };
        tokenRef.current = token;
        return token;
      })
      .finally(() => {
        tokenFetchRef.current = null;
      });
    return tokenFetchRef.current;
  }, []);

  /** Fetches a token ahead of the candidate's turn so the socket opens without a round trip. */
  const warm = useCallback(() => {
    if (capable && !failed) void getToken().catch(() => undefined);
  }, [capable, failed, getToken]);

  const closeCapture = (s: Session) => {
    if (s.captureClosed) return;
    s.captureClosed = true;
    s.node.port.onmessage = null;
    s.node.disconnect();
    s.source.disconnect();
    s.sink.disconnect();
    s.stream.getTracks().forEach((t) => t.stop());
    void s.context.close().catch(() => undefined);
  };

  const closeSocket = (s: Session) => {
    s.closedByUs = true;
    const ws = s.socket;
    s.socket = null;
    if (ws && ws.readyState <= WebSocket.OPEN) {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  };

  const teardown = useCallback(() => {
    genRef.current++;
    const s = sessionRef.current;
    sessionRef.current = null;
    if (s) {
      closeCapture(s);
      closeSocket(s);
    }
    setIsListening(false);
  }, []);

  useEffect(() => teardown, [teardown]);

  const handleMessage = (s: Session, raw: unknown) => {
    if (typeof raw !== "string" || s.closedByUs) return;
    let msg: {
      type?: string;
      is_final?: boolean;
      from_finalize?: boolean;
      channel?: { alternatives?: { transcript?: string }[] };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const cb = callbacksRef.current;
    if (msg.type === "SpeechStarted") {
      cb.onActivity();
    } else if (msg.type === "UtteranceEnd") {
      cb.onUtteranceEnd?.();
    } else if (msg.type === "Results") {
      const transcript = msg.channel?.alternatives?.[0]?.transcript?.trim() ?? "";
      if (msg.is_final) {
        s.interim = "";
        if (transcript) cb.onFinal(transcript);
        cb.onInterim("");
      } else if (transcript) {
        s.interim = transcript;
        cb.onInterim(transcript);
      }
      if (transcript) cb.onActivity();
      if (msg.from_finalize) s.finalized?.();
    }
  };

  /** Opens (or re-opens) the socket for a session and sends everything captured meanwhile. */
  const connect = useCallback(
    (s: Session): Promise<boolean> => {
      s.opening = (async () => {
        let token: Token;
        try {
          token = await getToken();
        } catch {
          return false;
        }
        if (s.gen !== genRef.current) return false;

        const params = new URLSearchParams({
          model: token.model,
          language: "en-US",
          encoding: "linear16",
          sample_rate: String(s.context.sampleRate),
          channels: "1",
          interim_results: "true",
          smart_format: "true",
          endpointing: "300",
          utterance_end_ms: String(UTTERANCE_END_MS),
          vad_events: "true",
        });
        const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ["bearer", token.token]);
        ws.binaryType = "arraybuffer";

        const opened = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), OPEN_TIMEOUT_MS);
          ws.onopen = () => {
            clearTimeout(timer);
            resolve(true);
          };
          ws.onerror = () => {
            clearTimeout(timer);
            resolve(false);
          };
          ws.onclose = () => {
            clearTimeout(timer);
            resolve(false);
          };
        });
        if (!opened || s.gen !== genRef.current || s.closedByUs) {
          try {
            ws.close();
          } catch {
            /* already closed */
          }
          // An expired token is the usual reason a socket is refused; don't reuse it.
          if (!opened) tokenRef.current = null;
          return false;
        }

        ws.onmessage = (e) => handleMessage(s, e.data);
        ws.onerror = null;
        ws.onclose = () => {
          if (s.closedByUs || s.ending || s.socket !== ws || s.gen !== genRef.current) return;
          // The connection dropped mid-answer: keep capturing into the queue and reconnect.
          s.socket = null;
          if (s.reconnects >= MAX_RECONNECTS) {
            callbacksRef.current.onFatalError(CONNECTION_LOST);
            return;
          }
          s.reconnects++;
          tokenRef.current = null;
          void connect(s).then((ok) => {
            if (!ok && s.gen === genRef.current && !s.closedByUs) callbacksRef.current.onFatalError(CONNECTION_LOST);
          });
        };
        s.socket = ws;
        for (const chunk of s.queue.splice(0)) ws.send(chunk);
        return true;
      })();
      return s.opening;
    },
    [getToken]
  );

  const sendBatch = (s: Session) => {
    if (s.pendingSamples === 0) return;
    const chunk = toInt16(s.pending, s.pendingSamples);
    s.pending = [];
    s.pendingSamples = 0;
    if (s.socket && s.socket.readyState === WebSocket.OPEN) s.socket.send(chunk);
    else s.queue.push(chunk);
  };

  const start = useCallback(async (): Promise<DeepgramStart> => {
    if (!capable) return "unavailable";
    teardown();
    const gen = ++genRef.current;

    // The token request and the permission prompt run side by side.
    void getToken().catch(() => undefined);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      if (gen === genRef.current) callbacksRef.current.onFatalError(MIC_BLOCKED);
      return "cancelled";
    }
    if (gen !== genRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return "cancelled";
    }

    let context: AudioContext;
    let node: AudioWorkletNode;
    try {
      context = new AudioContext();
      await context.audioWorklet.addModule(getWorkletUrl());
      node = new AudioWorkletNode(context, "pcm-capture");
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      setFailed(true);
      return "unavailable";
    }
    if (gen !== genRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      void context.close().catch(() => undefined);
      return "cancelled";
    }

    // The worklet only runs while connected to the destination; a muted gain keeps the mic from playing back.
    const source = context.createMediaStreamSource(stream);
    const sink = context.createGain();
    sink.gain.value = 0;
    source.connect(node);
    node.connect(sink);
    sink.connect(context.destination);
    void context.resume().catch(() => undefined);

    const s: Session = {
      gen,
      stream,
      context,
      source,
      node,
      sink,
      socket: null,
      queue: [],
      pending: [],
      pendingSamples: 0,
      opening: Promise.resolve(false),
      interim: "",
      finalized: null,
      reconnects: 0,
      ending: false,
      captureClosed: false,
      closedByUs: false,
    };
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      s.pending.push(e.data);
      s.pendingSamples += e.data.length;
      if (s.pendingSamples >= SEND_BATCH_SAMPLES) sendBatch(s);
    };
    sessionRef.current = s;
    setIsListening(true);

    // Audio is captured from now on; whatever is said while connecting is sent as soon as the socket opens.
    const ok = await connect(s);
    if (gen !== genRef.current) return "cancelled";
    if (!ok) {
      teardown();
      setFailed(true);
      return "unavailable";
    }
    return "listening";
  }, [capable, connect, getToken, teardown]);

  /** Sends the last words to Deepgram, waits for the final text, and closes the stream. */
  const stopAndFlush = useCallback(async () => {
    const s = sessionRef.current;
    if (!s || s.ending) return;
    s.ending = true;

    // Stop capturing first so nothing after "done" is sent, but keep what was already said.
    s.node.port.onmessage = null;
    sendBatch(s);
    closeCapture(s);

    if (!s.socket) await Promise.race([s.opening, sleep(LATE_OPEN_GRACE_MS)]);
    const ws = s.socket;
    if (ws && ws.readyState === WebSocket.OPEN) {
      for (const chunk of s.queue.splice(0)) ws.send(chunk);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
        s.finalized = () => {
          clearTimeout(timer);
          resolve();
        };
        try {
          ws.send(JSON.stringify({ type: "Finalize" }));
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
      try {
        ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch {
        /* already closed */
      }
    }
    // Words Deepgram heard but never finalized still belong to the answer.
    const leftover = s.interim.trim();
    s.interim = "";
    // Skipped when the turn was aborted while flushing.
    if (!s.closedByUs) {
      if (leftover) callbacksRef.current.onFinal(leftover);
      callbacksRef.current.onInterim("");
    }
    closeSocket(s);
    if (sessionRef.current === s) {
      sessionRef.current = null;
      setIsListening(false);
    }
  }, []);

  return { isSupported: capable && !failed, isListening, start, stopAndFlush, abort: teardown, warm };
}
