import { useRef } from "react";
import { useDeepgramRecognition } from "./useDeepgramRecognition";
import { useSpeechRecognition, type RecognitionCallbacks } from "./useSpeechRecognition";
import { useWhisperRecognition } from "./useWhisperRecognition";

// Unified voice input. Deepgram streaming is the primary engine: accurate on
// technical vocabulary, identical in every browser, and it reports when the
// speaker has really stopped. If it can't be used (no key on the server, no
// network path to Deepgram, no AudioWorklet), the turn silently falls back to
// the Web Speech API built into Chrome/Edge/Safari, and from there to a fully
// local Whisper-via-WASM model for browsers without it (e.g. Firefox). All
// hooks are always mounted (rules of hooks), but only the engine in use is
// ever started, and only by the conversation controller during the
// candidate's turn.

type Engine = "deepgram" | "web-speech" | "whisper";

export function useVoiceInput(callbacks: RecognitionCallbacks) {
  const deepgram = useDeepgramRecognition(callbacks);
  const webSpeech = useSpeechRecognition(callbacks);
  // The heavy on-device model is only loaded when nothing better can be used.
  const whisper = useWhisperRecognition(callbacks, !deepgram.isSupported && !webSpeech.isSupported);

  const primary: Engine = deepgram.isSupported ? "deepgram" : webSpeech.isSupported ? "web-speech" : "whisper";

  /** Engine running the current turn; lets stop/abort reach the right one. */
  const activeRef = useRef<Engine | null>(null);
  /** Bumped on every start/stop so a fallback never starts for a turn that is already over. */
  const turnRef = useRef(0);

  const startFallback = () => {
    if (webSpeech.isSupported) {
      activeRef.current = "web-speech";
      webSpeech.start();
    } else {
      activeRef.current = "whisper";
      void whisper.start();
    }
  };
  // Deepgram reports "unavailable" asynchronously, after a re-render; start the fallback from the latest closures.
  const fallbackRef = useRef(startFallback);
  fallbackRef.current = startFallback;

  const start = () => {
    const turn = ++turnRef.current;
    if (deepgram.isSupported) {
      activeRef.current = "deepgram";
      void deepgram.start().then((result) => {
        if (result === "unavailable" && turn === turnRef.current) setTimeout(() => fallbackRef.current(), 0);
      });
      return;
    }
    startFallback();
  };

  const stopAndFlush = async () => {
    turnRef.current++;
    const active = activeRef.current;
    activeRef.current = null;
    if (active === "deepgram") await deepgram.stopAndFlush();
    else if (active === "web-speech") await webSpeech.stopAndFlush();
    else if (active === "whisper") await whisper.stopAndFlush();
  };

  const abort = () => {
    turnRef.current++;
    activeRef.current = null;
    deepgram.abort();
    webSpeech.abort();
    whisper.abort();
  };

  const isListening =
    primary === "deepgram" ? deepgram.isListening || webSpeech.isListening : primary === "web-speech" ? webSpeech.isListening : whisper.isListening;

  return {
    engine: primary,
    isSupported: primary === "whisper" ? whisper.modelStatus !== "error" : true,
    isListening,
    modelStatus: primary === "whisper" ? whisper.modelStatus : ("ready" as const),
    start,
    stopAndFlush,
    abort,
    /** Gets the Deepgram connection ready while the interviewer is still talking. */
    warm: deepgram.warm,
  };
}

export type VoiceInput = ReturnType<typeof useVoiceInput>;
