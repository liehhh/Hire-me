import { z } from "zod";
import type { TtsResponse } from "../../../../shared/interviewTypes.js";
import { AppError } from "../gemini/geminiErrors.js";

/** Longest text accepted per request. The client sends one sentence at a time. */
export const MAX_TTS_CHARACTERS = 1_500;

export const ttsRequestSchema = z.object({
  text: z.string().trim().min(1, "Nothing to say.").max(MAX_TTS_CHARACTERS, "Text is too long to speak in one request."),
});

/** Turns text into audio. Injected so tests and the local server don't need the network. */
export type SpeechSynthesizer = (text: string) => Promise<{ audio: Uint8Array; mimeType: string }>;

export interface DeepgramOptions {
  apiKey: string;
  /** e.g. "aura-2-thalia-en" */
  model: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/** Deepgram Aura text-to-speech: MP3 at 24 kHz, mono. */
export function createDeepgramSynthesizer(opts: DeepgramOptions): SpeechSynthesizer {
  const doFetch = opts.fetchFn ?? fetch;
  const url = `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(opts.model)}&encoding=mp3`;
  return async (text) => {
    const res = await doFetch(url, {
      method: "POST",
      headers: { Authorization: `Token ${opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new Error(`Deepgram responded ${res.status}: ${detail}`);
    }
    return { audio: new Uint8Array(await res.arrayBuffer()), mimeType: res.headers.get("content-type") ?? "audio/mpeg" };
  };
}

/** Validates the request body and synthesizes it. Speech failures become a retryable 502. */
export async function speak(synthesize: SpeechSynthesizer, body: unknown): Promise<TtsResponse> {
  const { text } = ttsRequestSchema.parse(body);
  try {
    const { audio, mimeType } = await synthesize(text);
    return { audio: Buffer.from(audio).toString("base64"), mimeType, characters: text.length };
  } catch (err) {
    console.error("[tts] synthesis failed:", err);
    throw new AppError("INTERNAL_ERROR", "The interviewer's voice service is unavailable.", 502, true);
  }
}
