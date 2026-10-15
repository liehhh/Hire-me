import { describe, expect, it, vi } from "vitest";
import { DynamoStore, type DocClient } from "../persistence/dynamoStore.js";
import { createPollySynthesizer, type SpeechSynthesizer } from "../services/tts/ttsService.js";
import { createLambdaApp, type UrlEvent } from "./app.js";

/** In-memory stand-in for the DynamoDB counters (Update-ADD) the throttle uses. */
function fakeCounters(): DocClient {
  const items = new Map<string, number>();
  return {
    send: (async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
      if (cmd.constructor.name !== "UpdateCommand") throw new Error(`unexpected ${cmd.constructor.name}`);
      const total = (items.get(cmd.input.Key.pk) ?? 0) + cmd.input.ExpressionAttributeValues[":w"];
      items.set(cmd.input.Key.pk, total);
      return { Attributes: { hits: total } };
    }) as DocClient["send"],
  };
}

const AUDIO = new Uint8Array([1, 2, 3, 4]);

function harness(opts: { charsPerDay?: number; perMinute?: number; synthesize?: SpeechSynthesizer; noTts?: boolean } = {}) {
  const synthesize = opts.synthesize ?? vi.fn(async () => ({ audio: AUDIO, mimeType: "audio/mpeg" }));
  const db = new DynamoStore(fakeCounters(), "t");
  const app = createLambdaApp({
    service: {} as never,
    store: {} as never,
    db,
    model: "test-model",
    httpRequestsPerMinutePerIp: 60,
    geminiCallsPerDay: 0,
    sessionTtlMs: 1000,
    flushWaitMs: 1000,
    tts: opts.noTts
      ? undefined
      : { synthesize, charsPerDay: opts.charsPerDay ?? 0, requestsPerMinutePerIp: opts.perMinute ?? 60 },
  });
  const post = async (body: unknown, ip = "1.2.3.4") => {
    const event: UrlEvent = {
      rawPath: "/api/tts",
      body: typeof body === "string" ? body : JSON.stringify(body),
      requestContext: { http: { method: "POST", sourceIp: ip } },
    };
    const res = await app(event);
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  return { post, synthesize };
}

describe("POST /api/tts", () => {
  it("returns base64 audio for a sentence", async () => {
    const { post, synthesize } = harness();
    const res = await post({ text: "  Tell me about yourself.  " });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ audio: Buffer.from(AUDIO).toString("base64"), mimeType: "audio/mpeg", characters: 23 });
    expect(synthesize).toHaveBeenCalledWith("Tell me about yourself.");
  });

  it("rejects empty and oversized text without calling the voice service", async () => {
    const { post, synthesize } = harness();
    expect((await post({ text: "   " })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ text: "x".repeat(1501) })).status).toBe(400);
    expect((await post("not json")).status).toBe(400);
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("is a 404 when the cloud voice is not configured", async () => {
    const { post } = harness({ noTts: true });
    expect((await post({ text: "Hello." })).status).toBe(404);
  });

  it("stops at the daily character budget, and says so", async () => {
    const { post, synthesize } = harness({ charsPerDay: 30 });
    expect((await post({ text: "Twenty characters..." })).status).toBe(200);
    const over = await post({ text: "Another twenty chars.." });
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe("RATE_LIMITED");
    expect(over.body.error.retryable).toBe(false);
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it("rate limits per IP independently", async () => {
    const { post } = harness({ perMinute: 2 });
    expect((await post({ text: "One." }, "9.9.9.9")).status).toBe(200);
    expect((await post({ text: "Two." }, "9.9.9.9")).status).toBe(200);
    expect((await post({ text: "Three." }, "9.9.9.9")).status).toBe(429);
    expect((await post({ text: "Three." }, "8.8.8.8")).status).toBe(200);
  });

  it("maps a voice-service failure to a retryable 502 without leaking details", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { post } = harness({
      synthesize: async () => {
        throw new Error("AccessDenied: arn:aws:polly secret-detail");
      },
    });
    const res = await post({ text: "Hello." });
    expect(res.status).toBe(502);
    expect(res.body.error.retryable).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("secret-detail");
  });
});

describe("createPollySynthesizer", () => {
  it("asks Polly for 24 kHz neural MP3 with the configured voice", async () => {
    const send = vi.fn(async () => ({
      AudioStream: { transformToByteArray: async () => AUDIO },
      ContentType: "audio/mpeg",
    }));
    const synth = createPollySynthesizer({ voice: "Joanna", engine: "neural", client: { send } as never });
    await expect(synth("Hello.")).resolves.toEqual({ audio: AUDIO, mimeType: "audio/mpeg" });
    const input = (send.mock.calls[0] as unknown as [{ input: Record<string, unknown> }])[0].input;
    expect(input).toMatchObject({
      Text: "Hello.",
      TextType: "text",
      OutputFormat: "mp3",
      SampleRate: "24000",
      VoiceId: "Joanna",
      Engine: "neural",
    });
  });
});
