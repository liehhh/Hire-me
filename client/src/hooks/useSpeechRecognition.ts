import { useCallback, useEffect, useRef, useState } from "react";

// Minimal ambient typings for the Web Speech API — TypeScript's DOM lib
// doesn't ship these, and browser support/vendor-prefixing is inconsistent.
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}
interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface RecognitionCallbacks {
  /** A newly finalized piece of the answer (never repeats an earlier result index). */
  onFinal: (chunk: string) => void;
  /** Current not-yet-final text; replaces the previous interim text. */
  onInterim: (text: string) => void;
  /** The candidate is producing speech. */
  onActivity: () => void;
  /** The mic can't be used at all (permission denied, no device). */
  onFatalError: (message: string) => void;
}

/** Errors after which restarting is pointless. */
const FATAL_ERRORS: Record<string, string> = {
  "not-allowed": "Microphone access was blocked. Allow it in the browser, or type your answer.",
  "service-not-allowed": "Speech recognition is not allowed in this browser. Type your answer instead.",
  "audio-capture": "No microphone was found. Connect one, or type your answer.",
};

/** Longest we wait for the browser to deliver the last final result after stop(). */
const FLUSH_TIMEOUT_MS = 800;

/**
 * Web Speech API recognition, driven imperatively by the conversation
 * controller. It only runs between start() and stopAndFlush()/abort().
 * Browser sessions end on their own after pauses; while the candidate's turn
 * is still open, those ends are invisible to the caller: pending interim
 * text is kept and recognition restarts. An `onend` never ends the answer.
 */
export function useSpeechRecognition(callbacks: RecognitionCallbacks) {
  const [isSupported] = useState(() => getSpeechRecognitionCtor() !== null);
  const [isListening, setIsListening] = useState(false);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  /** True between start() and stop/abort — the candidate's turn is open. */
  const wantedRef = useRef(false);
  const interimRef = useRef("");
  const flushResolveRef = useRef<(() => void) | null>(null);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quickEndsRef = useRef(0);

  /** Keeps words the browser heard but never finalized (e.g. before an unexpected end). */
  const promoteInterim = () => {
    const pending = interimRef.current.trim();
    interimRef.current = "";
    callbacksRef.current.onInterim("");
    if (pending) callbacksRef.current.onFinal(pending);
  };

  const teardown = useCallback(() => {
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    restartTimerRef.current = null;
    const r = recognitionRef.current;
    recognitionRef.current = null;
    if (r) {
      r.onresult = null;
      r.onerror = null;
      r.onend = null;
      try {
        r.abort();
      } catch {
        // already stopped
      }
    }
    setIsListening(false);
  }, []);

  const start = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    teardown();
    wantedRef.current = true;
    interimRef.current = "";
    quickEndsRef.current = 0;

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    // Result indexes restart at 0 with every browser session.
    let emitted = new Set<number>();
    let sessionStartedAt = Date.now();

    recognition.onresult = (event) => {
      quickEndsRef.current = 0;
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) {
          if (!emitted.has(i) && text.trim()) {
            emitted.add(i);
            callbacksRef.current.onFinal(text.trim());
          }
        } else {
          interim += text;
        }
      }
      interimRef.current = interim;
      callbacksRef.current.onInterim(interim);
      if (interim.trim() || event.results.length > 0) callbacksRef.current.onActivity();
    };

    recognition.onerror = (event) => {
      const fatal = FATAL_ERRORS[event.error];
      if (fatal) {
        wantedRef.current = false;
        callbacksRef.current.onFatalError(fatal);
      }
      // "no-speech", "network", "aborted": onend follows and we restart.
    };

    recognition.onend = () => {
      if (flushResolveRef.current) {
        // Our own stop(): the browser has now delivered its last results.
        const resolve = flushResolveRef.current;
        flushResolveRef.current = null;
        resolve();
        return;
      }
      if (!wantedRef.current) {
        setIsListening(false);
        return;
      }
      // Unexpected end mid-turn: keep everything heard so far and resume.
      promoteInterim();
      if (Date.now() - sessionStartedAt < 1000) quickEndsRef.current++;
      // Resume almost immediately so no words are missed; back off only if
      // the browser keeps ending sessions instantly without hearing anything.
      const backoff = quickEndsRef.current <= 1 ? 50 : Math.min(2000, 250 * 2 ** Math.min(quickEndsRef.current - 1, 3));
      restartTimerRef.current = setTimeout(() => {
        if (!wantedRef.current || recognitionRef.current !== recognition) return;
        emitted = new Set();
        sessionStartedAt = Date.now();
        try {
          recognition.start();
        } catch {
          // start() while already started — harmless
        }
      }, backoff);
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setIsListening(true);
    } catch (err) {
      callbacksRef.current.onFatalError("Speech recognition could not start. Type your answer instead.");
      console.warn("[speech] start failed:", err);
    }
  }, [teardown]);

  /**
   * Ends the candidate's turn: stops listening, waits for the browser to
   * deliver any final result still in flight, and keeps leftover interim
   * words. Resolves once no more text will arrive.
   */
  const stopAndFlush = useCallback(async () => {
    wantedRef.current = false;
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    const r = recognitionRef.current;
    if (r) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          flushResolveRef.current = null;
          resolve();
        }, FLUSH_TIMEOUT_MS);
        flushResolveRef.current = () => {
          clearTimeout(timer);
          resolve();
        };
        try {
          r.stop();
        } catch {
          flushResolveRef.current = null;
          clearTimeout(timer);
          resolve();
        }
      });
    }
    promoteInterim();
    teardown();
  }, [teardown]);

  /** Stops immediately, discarding anything not yet final (interview ended). */
  const abort = useCallback(() => {
    wantedRef.current = false;
    flushResolveRef.current?.();
    flushResolveRef.current = null;
    interimRef.current = "";
    teardown();
  }, [teardown]);

  useEffect(() => () => abort(), [abort]);

  return { isSupported, isListening, start, stopAndFlush, abort };
}
