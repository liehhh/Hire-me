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
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

interface UseSpeechRecognitionOptions {
  onFinalTranscript: (text: string) => void;
  /** Suppress recognition while the avatar is talking, so it doesn't hear itself. */
  paused: boolean;
}

export function useSpeechRecognition({ onFinalTranscript, paused }: UseSpeechRecognitionOptions) {
  const [isSupported] = useState(() => getSpeechRecognitionCtor() !== null);
  const [isListening, setIsListening] = useState(false);
  const [interimText, setInterimText] = useState("");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const shouldRunRef = useRef(false);

  useEffect(() => {
    if (!isSupported) return;

    const Ctor = getSpeechRecognitionCtor()!;
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let finalChunk = "";
      let interimChunk = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) finalChunk += text;
        else interimChunk += text;
      }
      if (finalChunk.trim()) onFinalTranscript(finalChunk.trim());
      setInterimText(interimChunk);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      // "no-speech" fires routinely on silence; anything else we surface by stopping.
      if (event.error !== "no-speech") {
        setIsListening(false);
      }
    };

    recognition.onend = () => {
      setIsListening(false);
      // Auto-restart if we're still supposed to be listening (recognition
      // sessions end on their own after pauses) and we're not paused.
      if (shouldRunRef.current && !paused) {
        try {
          recognition.start();
          setIsListening(true);
        } catch {
          // ignore races where start() is called while already started
        }
      }
    };

    recognitionRef.current = recognition;

    return () => {
      shouldRunRef.current = false;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSupported]);

  useEffect(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;

    if (paused) {
      shouldRunRef.current = false;
      recognition.stop();
      return;
    }

    shouldRunRef.current = true;
    try {
      recognition.start();
      setIsListening(true);
    } catch {
      // already started — fine
    }
  }, [paused]);

  const stop = useCallback(() => {
    shouldRunRef.current = false;
    recognitionRef.current?.stop();
  }, []);

  return { isSupported, isListening, interimText, stop };
}
