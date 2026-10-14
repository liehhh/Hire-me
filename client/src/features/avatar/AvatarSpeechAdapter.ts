import type { TalkingHead } from "@met4citizen/talkinghead";
import {
  buildVisemeTimeline,
  computeEnvelope,
  computeSpeechBounds,
  defaultWordToVisemes,
  visemeAt,
  type VisemeEvent,
  type WordToVisemes,
} from "../tts/visemeTiming";

// Bridges generated speech audio to the 3D avatar's face without the avatar
// knowing anything about Kokoro: it receives raw PCM + timing metadata and
// animates mouth/head morph targets in sync with the playback clock.

export interface SpeechMetadata {
  /** Text spoken in this audio chunk. */
  text: string;
  sampleRate: number;
  /** Seconds. */
  duration: number;
  /** Playback-clock time (seconds) at which this chunk starts playing. */
  startAt: number;
  /** Reads the playback clock (AudioContext.currentTime) — freezes while paused. */
  clock: () => number;
}

export interface AvatarSpeechAdapter {
  /** Animates one chunk of mono Float32 PCM audio; resolves when it has finished. */
  speak(audioData: ArrayBuffer, metadata: SpeechMetadata): Promise<void>;
  /** Stops animating and relaxes the face back to neutral. */
  stop(): void;
  /** Stops and discards any queued chunks. */
  cancel(): void;
}

interface Segment {
  startAt: number;
  endAt: number;
  timeline: VisemeEvent[];
  envelope: Float32Array;
  clock: () => number;
  resolve: () => void;
}

const ENVELOPE_FRAME_S = 0.02;
// Overall mouth openness — kept below 1 so speech looks relaxed, not exaggerated.
const MOUTH_INTENSITY = 0.75;
// Envelope level at/above which the mouth reaches full viseme weight.
const ENVELOPE_KNEE = 0.3;
const HEAD_UPDATE_S = 0.12;

function wordToVisemesFor(head: TalkingHead): WordToVisemes {
  return (word) => {
    try {
      // TalkingHead's own English rule set (loaded via lipsyncModules: ["en"]).
      const processed = head.lipsyncPreProcessText(word, "en");
      const result = head.lipsyncWordsToVisemes(processed, "en");
      if (result?.visemes?.length) return result;
    } catch {
      // Lipsync module not loaded yet — use the built-in rules below.
    }
    return defaultWordToVisemes(word);
  };
}

export function createTalkingHeadSpeechAdapter(
  getHead: () => TalkingHead | null
): AvatarSpeechAdapter {
  let segments: Segment[] = [];
  let rafId: number | null = null;
  let currentViseme: string | null = null;
  let currentLevel = 0;
  let lastHeadUpdate = -Infinity;

  const setMouth = (head: TalkingHead, viseme: string | null, level: number) => {
    if (viseme !== currentViseme) {
      if (currentViseme) head.setValue(`viseme_${currentViseme}`, 0, 70);
      if (viseme) head.setValue(`viseme_${viseme}`, level, 60);
      currentViseme = viseme;
      currentLevel = level;
    } else if (viseme && Math.abs(level - currentLevel) > 0.08) {
      head.setValue(`viseme_${viseme}`, level, 50);
      currentLevel = level;
    }
  };

  const relax = () => {
    const head = getHead();
    if (head) {
      setMouth(head, null, 0);
      head.setValue("headRotateX", 0, 400);
      head.setValue("headRotateY", 0, 400);
    }
    currentViseme = null;
    currentLevel = 0;
    lastHeadUpdate = -Infinity;
  };

  const animateHead = (head: TalkingHead, segment: Segment, now: number) => {
    if (now - lastHeadUpdate < HEAD_UPDATE_S) return;
    lastHeadUpdate = now;
    // Slow, low-amplitude sway plus a small nod settling at each sentence
    // start. Purely a function of time, so it's smooth and repeatable.
    const sinceStart = now - segment.startAt;
    const nod = 0.05 * Math.exp(-sinceStart * 3) * Math.sin(Math.min(sinceStart, 1) * Math.PI);
    head.setValue("headRotateX", 0.025 * Math.sin(2 * Math.PI * 0.33 * now) + nod, 200);
    head.setValue("headRotateY", 0.03 * Math.sin(2 * Math.PI * 0.17 * now + 1), 200);
  };

  const tick = () => {
    rafId = null;
    if (!segments.length) {
      relax();
      return;
    }
    const now = segments[0].clock();
    // Retire chunks that have finished playing.
    while (segments.length && now >= segments[0].endAt) segments.shift()!.resolve();

    const head = getHead();
    const active = segments.find((s) => now >= s.startAt && now < s.endAt);
    if (head) {
      if (active) {
        const t = now - active.startAt;
        const event = visemeAt(active.timeline, t);
        const env = active.envelope[Math.floor(t / ENVELOPE_FRAME_S)] ?? 0;
        const loudness = Math.min(1, env / ENVELOPE_KNEE);
        setMouth(head, event?.viseme ?? null, event ? event.weight * MOUTH_INTENSITY * loudness : 0);
        animateHead(head, active, now);
      } else {
        setMouth(head, null, 0);
      }
    }
    if (segments.length) rafId = requestAnimationFrame(tick);
    else relax();
  };

  const stop = () => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
    const pending = segments;
    segments = [];
    pending.forEach((s) => s.resolve());
    relax();
  };

  return {
    speak(audioData, metadata) {
      const samples = new Float32Array(audioData);
      const head = getHead();
      const bounds = computeSpeechBounds(samples, metadata.sampleRate);
      const timeline = buildVisemeTimeline(metadata.text, metadata.duration, {
        speechStart: bounds.start,
        speechEnd: bounds.end,
        wordToVisemes: head ? wordToVisemesFor(head) : defaultWordToVisemes,
      });
      const envelope = computeEnvelope(samples, metadata.sampleRate, ENVELOPE_FRAME_S * 1000);

      return new Promise<void>((resolve) => {
        segments.push({
          startAt: metadata.startAt,
          endAt: metadata.startAt + metadata.duration,
          timeline,
          envelope,
          clock: metadata.clock,
          resolve,
        });
        segments.sort((a, b) => a.startAt - b.startAt);
        if (rafId === null) rafId = requestAnimationFrame(tick);
      });
    },
    stop,
    cancel: stop,
  };
}
