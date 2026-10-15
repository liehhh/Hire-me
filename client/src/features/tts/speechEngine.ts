import { isMobileDevice, urlFlag } from "../../lib/device";
import { getCloudSpeechClient } from "./cloudSpeech";
import { acquireKokoroClient, releaseKokoroClient, type KokoroClient, type WorkerLike } from "./kokoroClient";
import { isKokoroUnsafe } from "./kokoroGuard";

// Which engine speaks for the interviewer, behind one interface so playback,
// prebuffering and lip-sync don't care.
//   kokoro: on-device model in a Web Worker (desktop browsers)
//   cloud:  Amazon Polly through our own server (phones, where Kokoro takes
//           the whole page down on iOS Safari)

export type SpeechEngineKind = "kokoro" | "cloud";

/** What the TTS hook needs from an engine; KokoroClient and CloudSpeechClient both provide it. */
export type SpeechEngine = Pick<KokoroClient, "status" | "subscribe" | "load" | "synthesize" | "cancel">;

export function chooseSpeechEngine(env: {
  /** ?voice=cloud|kokoro */
  override: string | null;
  mobile: boolean;
  /** A previous page died while Kokoro was starting on this device. */
  kokoroUnsafe: boolean;
}): SpeechEngineKind {
  if (env.override === "cloud" || env.override === "kokoro") return env.override;
  return env.mobile || env.kokoroUnsafe ? "cloud" : "kokoro";
}

export function currentSpeechEngineKind(): SpeechEngineKind {
  return chooseSpeechEngine({ override: urlFlag("voice"), mobile: isMobileDevice(), kokoroUnsafe: isKokoroUnsafe() });
}

export interface SpeechEngineLease {
  engine: SpeechEngine;
  release(): void;
}

export function acquireSpeechEngine(kind: SpeechEngineKind, createWorker?: () => WorkerLike): SpeechEngineLease {
  if (kind === "cloud") return { engine: getCloudSpeechClient(), release: () => undefined };
  const client = acquireKokoroClient(createWorker);
  return { engine: client, release: () => releaseKokoroClient(client) };
}
