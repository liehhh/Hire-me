import { splitSentences } from "./cloudSpeech";

// Backup voice: the browser's own speechSynthesis. Used only when the cloud
// voice can't produce audio, so the interview continues instead of stalling.
// It is less natural than the cloud voice and exposes no audio, so the avatar
// cannot lip-sync to it.

export interface BrowserVoiceCallbacks {
  volume: number;
  /** The first sentence has started. */
  onStart: () => void;
  /** Every sentence has been spoken. */
  onEnd: () => void;
  onError: (error: Error) => void;
}

export function browserVoiceAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

const NATURAL = /premium|enhanced|natural|neural/i;
const KNOWN_GOOD = /google us english|samantha|ava\b|zoe|aria|jenny|allison|susan/i;

/** Prefers the most natural-sounding US English voice the device offers. */
export function pickEnglishVoice(voices: readonly SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const english = voices.filter((v) => /^en[-_]/i.test(v.lang));
  const score = (v: SpeechSynthesisVoice) =>
    (NATURAL.test(v.name) ? 4 : 0) + (KNOWN_GOOD.test(v.name) ? 2 : 0) + (/^en[-_]US$/i.test(v.lang) ? 1 : 0);
  return english.sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** Speaks the text one sentence at a time (long utterances are cut off by some browsers). */
export function speakWithBrowserVoice(text: string, cb: BrowserVoiceCallbacks): { cancel: () => void } {
  const synth = window.speechSynthesis;
  const sentences = splitSentences(text);
  let cancelled = false;
  synth.cancel();

  const voice = pickEnglishVoice(synth.getVoices());
  sentences.forEach((sentence, i) => {
    const utterance = new SpeechSynthesisUtterance(sentence);
    utterance.lang = "en-US";
    utterance.volume = cb.volume;
    if (voice) utterance.voice = voice;
    if (i === 0) utterance.onstart = () => !cancelled && cb.onStart();
    if (i === sentences.length - 1) utterance.onend = () => !cancelled && cb.onEnd();
    utterance.onerror = (event) => {
      // Cancelling our own speech reports "canceled"/"interrupted"; that is not a failure.
      if (cancelled || event.error === "canceled" || event.error === "interrupted") return;
      cancelled = true;
      synth.cancel();
      cb.onError(new Error(`Browser voice failed: ${event.error}`));
    };
    synth.speak(utterance);
  });

  if (sentences.length === 0) queueMicrotask(() => !cancelled && cb.onEnd());

  return {
    cancel: () => {
      cancelled = true;
      synth.cancel();
    },
  };
}
