import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { UrlEvent, UrlResult } from "./app.js";
import { createDeepgramTokenIssuer } from "../services/stt/sttService.js";
import { createDeepgramSynthesizer } from "../services/tts/ttsService.js";

// Entry point for AWS Lambda (Function URL). The Gemini key lives in SSM
// Parameter Store, not in the function's environment: it is fetched once per
// cold start, and `config` is imported only afterwards because it reads
// process.env at import time.

async function loadGeminiKey() {
  if (process.env.GEMINI_API_KEY) return; // e.g. local test runs
  const name = process.env.GEMINI_API_KEY_PARAMETER;
  if (!name) throw new Error("Set GEMINI_API_KEY_PARAMETER (SSM parameter name) or GEMINI_API_KEY.");
  const out = await new SSMClient({}).send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = out.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter ${name} is empty.`);
  process.env.GEMINI_API_KEY = value;
}

/** The voice key is optional: without it the app runs and /api/tts answers 404 (the browser then uses its own voice). */
async function loadDeepgramKey() {
  if (process.env.DEEPGRAM_API_KEY) return;
  const name = process.env.DEEPGRAM_API_KEY_PARAMETER;
  if (!name) return;
  try {
    const out = await new SSMClient({}).send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    if (out.Parameter?.Value) process.env.DEEPGRAM_API_KEY = out.Parameter.Value;
    else console.error(`[tts] SSM parameter ${name} is empty; the cloud voice is disabled.`);
  } catch (err) {
    console.error(`[tts] could not read SSM parameter ${name}; the cloud voice is disabled:`, err);
  }
}

async function init() {
  // Independent SSM reads: one round trip of cold-start latency instead of two.
  await Promise.all([loadGeminiKey(), loadDeepgramKey()]);
  const [{ config, LIMITS }, { generateStructured }, { InterviewService }, { SessionStore }, { DynamoStore }, { createLambdaApp }] =
    await Promise.all([
      import("../config.js"),
      import("../services/gemini/geminiClient.js"),
      import("../interview/interviewService.js"),
      import("../interview/session.js"),
      import("../persistence/dynamoStore.js"),
      import("./app.js"),
    ]);

  const store = new SessionStore();
  return createLambdaApp({
    tts:
      // Read from the environment, not `config`: that module is cached for the life of the
      // instance, so it would keep the empty key from a failed first attempt.
      config.ttsEnabled && process.env.DEEPGRAM_API_KEY
      ? {
          synthesize: createDeepgramSynthesizer({ apiKey: process.env.DEEPGRAM_API_KEY, model: config.deepgramModel }),
          charsPerDay: config.ttsCharsPerDay,
          requestsPerMinutePerIp: LIMITS.httpRequestsPerMinutePerIp,
        }
      : undefined,
    stt:
      config.sttEnabled && process.env.DEEPGRAM_API_KEY
        ? {
            issue: createDeepgramTokenIssuer({ apiKey: process.env.DEEPGRAM_API_KEY }),
            model: config.deepgramSttModel,
            sessionsPerDay: config.sttSessionsPerDay,
            requestsPerMinutePerIp: LIMITS.httpRequestsPerMinutePerIp,
          }
        : undefined,
    service: new InterviewService(generateStructured, store),
    store,
    db: new DynamoStore(DynamoDBDocumentClient.from(new DynamoDBClient({})), process.env.TABLE_NAME ?? "InterviewerAI"),
    model: config.geminiModel,
    httpRequestsPerMinutePerIp: LIMITS.httpRequestsPerMinutePerIp,
    geminiCallsPerDay: config.geminiRequestsPerDay,
    sessionTtlMs: LIMITS.finishedSessionTtlMs,
  });
}

// Cached across warm invocations; a failed init is retried on the next request.
let app: ReturnType<typeof init> | undefined;
let initializedAt = 0;
/** Wait this long before trying again to read a voice key that could not be read. */
const VOICE_KEY_RETRY_MS = 30_000;

/** True when the voice key is configured in SSM but was not loaded (e.g. permission added after this instance started). */
const voiceKeyMissing = () => Boolean(process.env.DEEPGRAM_API_KEY_PARAMETER) && !process.env.DEEPGRAM_API_KEY;

/** A re-init (to pick up a voice key that was missing) running beside the app that is serving requests. */
let refreshing: Promise<void> | undefined;

export async function handler(event: UrlEvent): Promise<UrlResult> {
  if (app && !refreshing && voiceKeyMissing() && Date.now() - initializedAt > VOICE_KEY_RETRY_MS) {
    // Retry in the background so this request does not wait on SSM and the module imports.
    refreshing = init()
      .then((created) => {
        app = Promise.resolve(created);
      })
      .catch((err) => console.error("[tts] retrying the voice key failed:", err))
      .finally(() => {
        initializedAt = Date.now();
        refreshing = undefined;
      });
  }
  app ??= init().then((created) => {
    initializedAt = Date.now();
    return created;
  }).catch((err) => {
    app = undefined;
    throw err;
  });
  return (await app)(event);
}
