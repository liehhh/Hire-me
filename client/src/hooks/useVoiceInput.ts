import { useSpeechRecognition, type RecognitionCallbacks } from "./useSpeechRecognition";
import { useWhisperRecognition } from "./useWhisperRecognition";

// Unified voice input: Web Speech API first (fast, free, built into
// Chrome/Edge/Safari), with a fully local Whisper-via-WASM fallback for
// browsers that lack it (e.g. Firefox). Both hooks are always mounted
// (rules of hooks), but only the selected engine is ever started, and only
// by the conversation controller during the candidate's turn.

export function useVoiceInput(callbacks: RecognitionCallbacks) {
  const webSpeech = useSpeechRecognition(callbacks);
  const whisper = useWhisperRecognition(callbacks, !webSpeech.isSupported);

  if (webSpeech.isSupported) {
    return {
      engine: "web-speech" as const,
      isSupported: true,
      isListening: webSpeech.isListening,
      modelStatus: "ready" as const,
      start: webSpeech.start,
      stopAndFlush: webSpeech.stopAndFlush,
      abort: webSpeech.abort,
    };
  }

  return {
    engine: "whisper" as const,
    isSupported: whisper.modelStatus !== "error",
    isListening: whisper.isListening,
    modelStatus: whisper.modelStatus,
    start: () => void whisper.start(),
    stopAndFlush: whisper.stopAndFlush,
    abort: whisper.abort,
  };
}

export type VoiceInput = ReturnType<typeof useVoiceInput>;
