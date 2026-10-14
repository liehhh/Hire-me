import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { AvatarSpeechAdapter } from "../avatar/AvatarSpeechAdapter";
import { getAudioContext, SpeechPlayer, unlockAudio } from "./audioPlayback";
import {
  acquireKokoroClient,
  releaseKokoroClient,
  type KokoroClient,
  type KokoroClientStatus,
  type WorkerLike,
} from "./kokoroClient";
import { DEFAULT_TTS_CONFIG, type KokoroVoiceConfig, type TTSAudioChunk } from "./kokoroTypes";
import { PrebufferGate } from "./prebufferGate";

// React entry point for local Kokoro speech: text in → audio out of the
// speakers, with the avatar's face driven via an AvatarSpeechAdapter.
// Only the newest speak() call is ever audible; older ones are cancelled.

export const TTS_ERROR_MESSAGE =
  "The local interviewer voice could not be generated. Please retry. Your interview response is still available as text.";

export type SpeakOutcome = "completed" | "cancelled" | "error";

export interface SpeakCallbacks {
  /** Generation (and, on first use, model loading) has begun. */
  onGenerating?: () => void;
  /** Audio has started playing. */
  onStart?: () => void;
  /** Audio finished playing (or was stopped via stop()). */
  onEnd?: () => void;
  /** Superseded by a newer speak() or cancelled via cancel(). */
  onCancel?: () => void;
  onError?: (error: Error) => void;
}

export interface UseKokoroTTSOptions extends Partial<KokoroVoiceConfig> {
  /** Avatar to lip-sync with the generated audio. */
  avatar?: RefObject<AvatarSpeechAdapter | null>;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onSpeechCancel?: () => void;
  onSpeechError?: (error: Error) => void;
  onModelLoading?: (progress: number | null) => void;
  onModelReady?: () => void;
  /** Test seams. */
  createWorker?: () => WorkerLike;
  getAudioContext?: () => AudioContext;
}

interface ActiveSpeech {
  token: number;
  callbacks: SpeakCallbacks;
  finish: (outcome: SpeakOutcome) => void;
}

export function useKokoroTTS(options: UseKokoroTTSOptions = {}) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const clientRef = useRef<KokoroClient | null>(null);
  const playerRef = useRef<SpeechPlayer | null>(null);
  const mountedRef = useRef(false);
  const activeRef = useRef<ActiveSpeech | null>(null);
  const tokenRef = useRef(0);
  const speakingRef = useRef(false);
  const lastRequestRef = useRef<{ text: string; callbacks: SpeakCallbacks } | null>(null);

  const [status, setStatus] = useState<KokoroClientStatus>({
    modelState: "idle",
    progress: null,
    device: null,
    error: null,
  });
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsAudioUnlock, setNeedsAudioUnlock] = useState(false);

  // Guards every state update so late worker/audio events can't touch an
  // unmounted component.
  const ifMounted = useCallback((fn: () => void) => {
    if (mountedRef.current) fn();
  }, []);

  const setSpeaking = useCallback(
    (value: boolean) => {
      speakingRef.current = value;
      ifMounted(() => setIsSpeaking(value));
    },
    [ifMounted]
  );

  /** Tears down the active utterance: worker generation, audio, and avatar. */
  const interrupt = useCallback(
    (reason: "cancel" | "stop" | "unmount") => {
      const active = activeRef.current;
      if (!active) return;
      activeRef.current = null;
      tokenRef.current++;
      clientRef.current?.cancel();
      playerRef.current?.stop();
      optionsRef.current.avatar?.current?.cancel();
      speakingRef.current = false;
      ifMounted(() => {
        setIsGenerating(false);
        setIsSpeaking(false);
      });
      if (reason === "cancel") {
        active.callbacks.onCancel?.();
        optionsRef.current.onSpeechCancel?.();
      } else if (reason === "stop") {
        active.callbacks.onEnd?.();
        optionsRef.current.onSpeechEnd?.();
      }
      active.finish(reason === "stop" ? "completed" : "cancelled");
    },
    [ifMounted]
  );

  useEffect(() => {
    mountedRef.current = true;
    const client = acquireKokoroClient(optionsRef.current.createWorker);
    clientRef.current = client;
    playerRef.current = new SpeechPlayer(optionsRef.current.getAudioContext ?? getAudioContext);

    let previousState = client.status.modelState;
    const unsubscribe = client.subscribe((next) => {
      ifMounted(() => setStatus(next));
      if (next.modelState === "loading") optionsRef.current.onModelLoading?.(next.progress);
      if (next.modelState === "ready" && previousState !== "ready") optionsRef.current.onModelReady?.();
      previousState = next.modelState;
    });

    return () => {
      interrupt("unmount");
      mountedRef.current = false;
      unsubscribe();
      playerRef.current?.stop();
      playerRef.current = null;
      clientRef.current = null;
      releaseKokoroClient(client);
    };
  }, [ifMounted, interrupt]);

  const speak = useCallback(
    (text: string, callbacks: SpeakCallbacks = {}): Promise<SpeakOutcome> => {
      interrupt("cancel");
      const client = clientRef.current;
      const player = playerRef.current;
      const trimmed = text.trim();
      if (!client || !player || !trimmed) return Promise.resolve("cancelled");

      lastRequestRef.current = { text, callbacks };
      const token = ++tokenRef.current;
      const isStale = () => tokenRef.current !== token;
      const opts = optionsRef.current;
      const voice = opts.voice ?? DEFAULT_TTS_CONFIG.voice;
      const speed = opts.speed ?? DEFAULT_TTS_CONFIG.speed;
      const volume = opts.volume ?? DEFAULT_TTS_CONFIG.volume;
      const getCtx = opts.getAudioContext ?? getAudioContext;

      return new Promise<SpeakOutcome>((resolve) => {
        let settled = false;
        const finish = (outcome: SpeakOutcome) => {
          if (settled) return;
          settled = true;
          resolve(outcome);
        };
        activeRef.current = { token, callbacks, finish };

        (async () => {
          ifMounted(() => {
            setError(null);
            setIsGenerating(true);
          });
          callbacks.onGenerating?.();

          // Usually already unlocked by the "Start Interview" click; if the
          // browser still blocks audio, surface a button instead of failing.
          void unlockAudio(getCtx).then((ok) => {
            if (!isStale()) ifMounted(() => setNeedsAudioUnlock(!ok));
          });

          await client.load(voice);
          if (isStale()) return;

          let markEnded!: () => void;
          const ended = new Promise<void>((r) => (markEnded = r));
          player.begin(volume, {
            onStart: () => {
              if (isStale()) return;
              setSpeaking(true);
              callbacks.onStart?.();
              optionsRef.current.onSpeechStart?.();
            },
            onEnd: () => markEnded(),
          });

          const play = (chunk: TTSAudioChunk) => {
            const scheduled = player.enqueue(new Float32Array(chunk.audioData), chunk.sampleRate);
            if (!scheduled) return;
            void optionsRef.current.avatar?.current?.speak(chunk.audioData, {
              text: chunk.text,
              sampleRate: chunk.sampleRate,
              duration: scheduled.duration,
              startAt: scheduled.startAt,
              clock: () => player.now(),
            });
          };
          // Sentences are held back only as long as needed for gap-free playback.
          const gate = new PrebufferGate(trimmed.length);
          let held: TTSAudioChunk[] | null = [];
          const release = () => {
            const chunks = held ?? [];
            if (held && process.env.NODE_ENV !== "production") {
              const seconds = chunks.reduce((sum, c) => sum + c.duration, 0);
              console.debug(`[kokoro-tts] playback starts with ${chunks.length} sentence(s), ${seconds.toFixed(1)}s buffered`);
            }
            held = null;
            chunks.forEach(play);
          };

          const { done } = client.synthesize(trimmed, { voice, speed }, (chunk) => {
            if (isStale()) return;
            if (!held) return play(chunk);
            held.push(chunk);
            if (gate.add(chunk.text.length, chunk.duration)) release();
          });

          const outcome = await done;
          if (isStale() || outcome === "cancelled") return;
          release();
          ifMounted(() => setIsGenerating(false));

          player.finish();
          await ended;
          if (isStale()) return;

          activeRef.current = null;
          setSpeaking(false);
          callbacks.onEnd?.();
          optionsRef.current.onSpeechEnd?.();
          finish("completed");
        })().catch((err: unknown) => {
          if (isStale()) return;
          const error = err instanceof Error ? err : new Error(String(err));
          activeRef.current = null;
          tokenRef.current++;
          clientRef.current?.cancel();
          player.stop();
          optionsRef.current.avatar?.current?.cancel();
          speakingRef.current = false;
          ifMounted(() => {
            setIsGenerating(false);
            setIsSpeaking(false);
            setError(TTS_ERROR_MESSAGE);
          });
          if (process.env.NODE_ENV !== "production") console.error("[kokoro-tts] speech generation failed:", error);
          callbacks.onError?.(error);
          optionsRef.current.onSpeechError?.(error);
          finish("error");
        });
      });
    },
    [ifMounted, interrupt, setSpeaking]
  );

  /**
   * Starts loading (and warming up) the model ahead of the first speak(), so
   * it happens while the first question is still being prepared.
   */
  const preload = useCallback(() => {
    clientRef.current?.load(optionsRef.current.voice ?? DEFAULT_TTS_CONFIG.voice).catch(() => {
      // speak() retries the load and reports the error.
    });
  }, []);

  /** Re-speaks the most recent text (e.g. after an error). */
  const retry = useCallback((): Promise<SpeakOutcome> => {
    const last = lastRequestRef.current;
    return last ? speak(last.text, last.callbacks) : Promise.resolve("cancelled");
  }, [speak]);

  /** Ends the current speech immediately, firing onEnd. */
  const stop = useCallback(() => interrupt("stop"), [interrupt]);
  /** Abandons the current speech, firing onCancel. */
  const cancel = useCallback(() => interrupt("cancel"), [interrupt]);
  const pause = useCallback(() => playerRef.current?.pause(), []);
  const resume = useCallback(() => playerRef.current?.resume(), []);

  /** Retries unlocking audio from a user gesture (e.g. an "enable audio" button). */
  const enableAudio = useCallback(async () => {
    const ok = await unlockAudio(optionsRef.current.getAudioContext ?? getAudioContext);
    ifMounted(() => setNeedsAudioUnlock(!ok));
    return ok;
  }, [ifMounted]);

  /** Synchronous check, for event handlers that can't wait for a re-render. */
  const isSpeakingNow = useCallback(() => speakingRef.current, []);

  return {
    speak,
    preload,
    stop,
    cancel,
    pause,
    resume,
    retry,
    enableAudio,
    isSpeakingNow,
    isLoadingModel: status.modelState === "loading",
    isGenerating,
    isSpeaking,
    isReady: status.modelState === "ready",
    needsAudioUnlock,
    error,
    progress: status.progress,
    device: status.device,
  };
}
