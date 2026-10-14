import { useCallback, useEffect, useRef, useState } from "react";
import type { RecognitionCallbacks } from "./useSpeechRecognition";

// Local, fully-offline speech-to-text fallback for browsers without the Web
// Speech API (Firefox, Safari in some configurations, etc.) — runs a small
// Whisper model entirely client-side via transformers.js (WASM/ONNX
// Runtime), so no audio ever leaves the browser. The model only loads when
// `enabled` (Web Speech unavailable); the mic only runs between start() and
// stopAndFlush()/abort(), i.e. during the candidate's turn.

const SAMPLE_RATE = 16000; // required input rate for Whisper
const SILENCE_RMS_THRESHOLD = 0.012;
// Silence that closes a *segment* for transcription — not the answer.
const SEGMENT_SILENCE_MS = 1200;
const MIN_SEGMENT_MS = 400;
const MAX_SEGMENT_MS = 20000; // safety cap so one very long run-on utterance still gets flushed
const ACTIVITY_THROTTLE_MS = 250;

type ModelStatus = "idle" | "loading" | "ready" | "error";

// transformers.js's automatic-speech-recognition pipeline — typed loosely
// since the package's generated types vary across versions and we only use
// a handful of call shapes here.
type Transcriber = (
  audio: Float32Array,
  options?: Record<string, unknown>
) => Promise<{ text: string } | { text: string }[]>;

function downsampleTo16k(buffer: Float32Array, inputSampleRate: number): Float32Array {
  if (inputSampleRate === SAMPLE_RATE) return buffer;
  const ratio = inputSampleRate / SAMPLE_RATE;
  const outLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    result[i] = buffer[Math.min(buffer.length - 1, Math.round(i * ratio))];
  }
  return result;
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

interface Capture {
  stream: MediaStream;
  audioContext: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  silentGain: GainNode;
  flushSegment: () => void;
}

export function useWhisperRecognition(callbacks: RecognitionCallbacks, enabled: boolean) {
  const [modelStatus, setModelStatus] = useState<ModelStatus>("idle");
  const [isListening, setIsListening] = useState(false);
  const transcriberRef = useRef<Transcriber | null>(null);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const captureRef = useRef<Capture | null>(null);
  /** Bumped on every start/stop so a late getUserMedia can't revive a closed turn. */
  const generationRef = useRef(0);
  /** Transcriptions still running; awaited before the answer is locked. */
  const pendingRef = useRef(new Set<Promise<void>>());

  // Load the model once, lazily, the first time it's actually needed.
  useEffect(() => {
    if (!enabled || modelStatus !== "idle") return;
    let cancelled = false;
    setModelStatus("loading");

    (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      const transcriber = (await pipeline(
        "automatic-speech-recognition",
        "Xenova/whisper-tiny.en"
      )) as unknown as Transcriber;
      if (cancelled) return;
      transcriberRef.current = transcriber;
      setModelStatus("ready");
    })().catch((err) => {
      console.error("Failed to load local Whisper model:", err);
      if (!cancelled) setModelStatus("error");
    });

    return () => {
      cancelled = true;
    };
  }, [enabled, modelStatus]);

  const releaseCapture = useCallback(() => {
    const c = captureRef.current;
    captureRef.current = null;
    if (c) {
      c.processor.onaudioprocess = null;
      c.processor.disconnect();
      c.source.disconnect();
      c.silentGain.disconnect();
      c.stream.getTracks().forEach((t) => t.stop());
      void c.audioContext.close();
    }
    setIsListening(false);
  }, []);

  const start = useCallback(async () => {
    releaseCapture();
    const generation = ++generationRef.current;
    if (!transcriberRef.current) {
      callbacksRef.current.onFatalError("The on-device speech model isn't ready yet. Type your answer for now.");
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      callbacksRef.current.onFatalError("Microphone access was blocked. Allow it in the browser, or type your answer.");
      return;
    }
    if (generation !== generationRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    // ScriptProcessorNode only fires onaudioprocess while connected into
    // the graph's destination; route through a silent gain node so we
    // never actually play the mic back out loud.
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;

    let segments: Float32Array[] = [];
    let isSpeaking = false;
    let silenceStartedAt: number | null = null;
    let segmentStartedAt = 0;
    let lastActivityAt = 0;

    const flushSegment = () => {
      const chunks = segments;
      segments = [];
      isSpeaking = false;
      silenceStartedAt = null;
      if (!chunks.length) return;

      const totalSamples = chunks.reduce((sum, c) => sum + c.length, 0);
      if ((totalSamples / audioContext.sampleRate) * 1000 < MIN_SEGMENT_MS) return;

      const merged = new Float32Array(totalSamples);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      const resampled = downsampleTo16k(merged, audioContext.sampleRate);
      const transcriber = transcriberRef.current;
      if (!transcriber) return;

      const job: Promise<void> = transcriber(resampled, { language: "english" })
        .then((result) => {
          const first = Array.isArray(result) ? result[0] : result;
          const text = first?.text?.trim();
          // Segments from an aborted turn are dropped.
          if (text && generation === generationRef.current) callbacksRef.current.onFinal(text);
        })
        .catch((err) => console.error("Whisper transcription failed:", err))
        .finally(() => pendingRef.current.delete(job));
      pendingRef.current.add(job);
    };

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const level = rms(input);
      const now = Date.now();

      if (level > SILENCE_RMS_THRESHOLD) {
        if (!isSpeaking) {
          isSpeaking = true;
          segmentStartedAt = now;
        }
        silenceStartedAt = null;
        segments.push(new Float32Array(input));
        if (now - lastActivityAt > ACTIVITY_THROTTLE_MS) {
          lastActivityAt = now;
          callbacksRef.current.onActivity();
        }
        if (now - segmentStartedAt > MAX_SEGMENT_MS) flushSegment();
      } else if (isSpeaking) {
        segments.push(new Float32Array(input)); // keep trailing silence for natural word endings
        if (silenceStartedAt === null) silenceStartedAt = now;
        if (now - silenceStartedAt >= SEGMENT_SILENCE_MS) flushSegment();
      }
    };

    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(audioContext.destination);
    captureRef.current = { stream, audioContext, source, processor, silentGain, flushSegment };
    setIsListening(true);
  }, [releaseCapture]);

  /** Transcribes whatever is still buffered and waits for every pending transcription. */
  const stopAndFlush = useCallback(async () => {
    const c = captureRef.current;
    c?.flushSegment();
    releaseCapture();
    while (pendingRef.current.size > 0) {
      await Promise.all([...pendingRef.current]);
    }
    generationRef.current++;
  }, [releaseCapture]);

  const abort = useCallback(() => {
    generationRef.current++;
    releaseCapture();
  }, [releaseCapture]);

  useEffect(() => () => abort(), [abort]);

  return { modelStatus, isListening, start, stopAndFlush, abort };
}
