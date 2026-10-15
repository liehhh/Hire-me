import { PollyClient, SynthesizeSpeechCommand, type Engine, type VoiceId } from "@aws-sdk/client-polly";
import { z } from "zod";
import type { TtsResponse } from "../../../../shared/interviewTypes.js";
import { AppError } from "../gemini/geminiErrors.js";

/** Longest text accepted per request. The client sends one sentence at a time. */
export const MAX_TTS_CHARACTERS = 1_500;

export const ttsRequestSchema = z.object({
  text: z.string().trim().min(1, "Nothing to say.").max(MAX_TTS_CHARACTERS, "Text is too long to speak in one request."),
});

/** Turns text into audio. Injected so tests and the local server don't need AWS. */
export type SpeechSynthesizer = (text: string) => Promise<{ audio: Uint8Array; mimeType: string }>;

export interface PollyOptions {
  voice: string;
  engine: string;
  /** Region to call Polly in; defaults to the caller's. Not every region offers every engine. */
  region?: string;
  client?: Pick<PollyClient, "send">;
}

/** Amazon Polly with the neural (or generative) engine; MP3 at 24 kHz. */
export function createPollySynthesizer(opts: PollyOptions): SpeechSynthesizer {
  const client = opts.client ?? new PollyClient(opts.region ? { region: opts.region } : {});
  return async (text) => {
    const out = await client.send(
      new SynthesizeSpeechCommand({
        Text: text,
        TextType: "text",
        OutputFormat: "mp3",
        SampleRate: "24000",
        VoiceId: opts.voice as VoiceId,
        Engine: opts.engine as Engine,
        LanguageCode: "en-US",
      })
    );
    if (!out.AudioStream) throw new Error("Polly returned no audio.");
    return { audio: await out.AudioStream.transformToByteArray(), mimeType: out.ContentType ?? "audio/mpeg" };
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
