import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { TalkingHead } from "@met4citizen/talkinghead";

// A default rigged Ready Player Me GLB, self-hosted from /public instead of
// fetched from models.readyplayer.me at runtime — that CDN is blocked on
// some corporate networks (incl. this one), which otherwise breaks avatar
// loading entirely. Sourced from TalkingHead's own repo, CC BY-NC 4.0.
// Swappable per-persona later by passing a different url prop.
const DEFAULT_AVATAR_URL = "/avatars/brunette.glb";

// TalkingHead's own speakText() always POSTs to a Google Cloud Text-to-Speech
// REST endpoint (ttsEndpoint) to get both audio and word-level timepoints —
// it has no browser-native speech fallback, and Cloud TTS needs a billed GCP
// service account, not a plain Gemini API key. Instead, the server
// synthesizes real neural speech via Gemini's native TTS model and sends it
// as a WAV data URL alongside the text; we play that directly and drive the
// avatar's mouth ourselves via TalkingHead's low-level setValue() morph
// target API, cycling viseme shapes for the audio's duration. If synthesis
// ever fails server-side, we fall back to the browser's own SpeechSynthesis
// so the call still has *some* voice.
const FLAP_VISEMES = ["viseme_aa", "viseme_E", "viseme_O", "viseme_U", "viseme_PP"];
const FLAP_INTERVAL_MS = 150;

export interface SpeechAudio {
  base64: string;
  mimeType: string;
}

export interface AvatarHandle {
  /** Speaks text aloud (via server-synthesized audio, or browser TTS as fallback) while flapping the 3D head's mouth. */
  speakText: (text: string, audio?: SpeechAudio | null) => void;
  /** Immediately stops any in-progress speech (used when the candidate barges in). */
  interrupt: () => void;
  /** True while the avatar is actively speaking (used to pause mic input). */
  isSpeaking: () => boolean;
}

interface AvatarContainerProps {
  onSpeakingChange?: (speaking: boolean) => void;
}

function pickBrowserVoice(): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  return (
    voices.find((v) => v.lang.startsWith("en") && /female|samantha|zira|aria/i.test(v.name)) ??
    voices.find((v) => v.lang.startsWith("en")) ??
    voices[0]
  );
}

interface PendingSpeech {
  text: string;
  audio?: SpeechAudio | null;
}

// We load @met4citizen/talkinghead dynamically rather than importing it at
// module scope: the library pulls in Three.js and touches `window` on
// construction, which breaks SSR/test environments if imported eagerly.
export const AvatarContainer = forwardRef<AvatarHandle, AvatarContainerProps>(
  function AvatarContainer({ onSpeakingChange }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const headRef = useRef<TalkingHead | null>(null);
    const audioElRef = useRef<HTMLAudioElement | null>(null);
    const isSpeakingRef = useRef(false);
    const flapTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    // Holds speech requested before the 3D model finished loading, so the
    // initial greeting (which arrives almost immediately over the socket)
    // isn't silently dropped while the GLB is still downloading/parsing.
    const pendingSpeechRef = useRef<PendingSpeech | null>(null);
    const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
    const [errorMessage, setErrorMessage] = useState("");

    if (!audioElRef.current && typeof Audio !== "undefined") {
      audioElRef.current = new Audio();
    }

    const stopFlapping = () => {
      if (flapTimerRef.current) {
        clearInterval(flapTimerRef.current);
        flapTimerRef.current = null;
      }
      const head = headRef.current;
      if (head) {
        FLAP_VISEMES.forEach((v) => head.setValue(v, 0, 200));
      }
      isSpeakingRef.current = false;
      onSpeakingChange?.(false);
    };

    const startFlapping = () => {
      const head = headRef.current;
      if (!head) return;
      isSpeakingRef.current = true;
      onSpeakingChange?.(true);
      let i = 0;
      flapTimerRef.current = setInterval(() => {
        FLAP_VISEMES.forEach((v) => head.setValue(v, 0, 60));
        head.setValue(FLAP_VISEMES[i], 0.6, 80);
        i = (i + 1) % FLAP_VISEMES.length;
      }, FLAP_INTERVAL_MS);
    };

    const speakWithBrowserTts = (text: string) => {
      if (!text.trim() || !("speechSynthesis" in window)) return;
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      const voice = pickBrowserVoice();
      if (voice) utterance.voice = voice;
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      utterance.onstart = startFlapping;
      utterance.onend = stopFlapping;
      utterance.onerror = stopFlapping;
      window.speechSynthesis.speak(utterance);
    };

    const speak = (text: string, audio?: SpeechAudio | null) => {
      if (!headRef.current) {
        pendingSpeechRef.current = { text, audio };
        return;
      }

      window.speechSynthesis?.cancel();
      const audioEl = audioElRef.current;

      if (audio && audioEl) {
        audioEl.pause();
        audioEl.onplay = startFlapping;
        audioEl.onended = stopFlapping;
        audioEl.onerror = () => {
          // Server-synthesized audio failed to play (e.g. unsupported
          // codec) — fall back to the browser's own voice rather than
          // going silent.
          speakWithBrowserTts(text);
        };
        audioEl.src = `data:${audio.mimeType};base64,${audio.base64}`;
        audioEl.play().catch(() => speakWithBrowserTts(text));
      } else {
        speakWithBrowserTts(text);
      }
    };

    useEffect(() => {
      let disposed = false;

      async function init() {
        if (!containerRef.current) return;
        try {
          const { TalkingHead } = await import("@met4citizen/talkinghead");

          const head = new TalkingHead(containerRef.current, {
            lipsyncModules: ["en"],
            cameraView: "upper",
          });

          await head.showAvatar({
            url: DEFAULT_AVATAR_URL,
            body: "F",
            avatarMood: "neutral",
          });

          if (disposed) return;
          headRef.current = head;
          setStatus("ready");

          if (pendingSpeechRef.current) {
            const { text, audio } = pendingSpeechRef.current;
            pendingSpeechRef.current = null;
            speak(text, audio);
          }
        } catch (err) {
          console.error("Failed to initialize TalkingHead avatar:", err);
          if (!disposed) {
            setErrorMessage(err instanceof Error ? err.message : "Unknown error");
            setStatus("error");
          }
        }
      }

      if ("speechSynthesis" in window) {
        // Voice list loads asynchronously in some browsers; priming it here
        // means the fallback path has options ready if it's ever needed.
        window.speechSynthesis.getVoices();
      }

      init();

      return () => {
        disposed = true;
        if (flapTimerRef.current) clearInterval(flapTimerRef.current);
        window.speechSynthesis?.cancel();
        audioElRef.current?.pause();
        headRef.current?.stop?.();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useImperativeHandle(ref, () => ({
      speakText(text: string, audio?: SpeechAudio | null) {
        speak(text, audio);
      },
      interrupt() {
        window.speechSynthesis?.cancel();
        audioElRef.current?.pause();
        pendingSpeechRef.current = null;
        stopFlapping();
      },
      isSpeaking() {
        return isSpeakingRef.current;
      },
    }));

    return (
      <div className="relative h-full w-full overflow-hidden rounded-xl bg-slate-900">
        <div ref={containerRef} className="h-full w-full" />
        {status === "loading" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-900 text-slate-300">
            <Loader2 className="h-8 w-8 animate-spin" />
            <p className="text-sm">Loading interviewer avatar...</p>
          </div>
        )}
        {status === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-slate-900 px-6 text-center text-slate-300">
            <p className="text-sm font-medium text-red-400">Avatar failed to load</p>
            <p className="text-xs text-slate-500">{errorMessage}</p>
            <p className="text-xs text-slate-500">
              The interview will continue via captions and voice only.
            </p>
          </div>
        )}
      </div>
    );
  }
);
