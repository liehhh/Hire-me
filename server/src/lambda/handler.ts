import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { UrlEvent, UrlResult } from "./app.js";
import { createPollySynthesizer } from "../services/tts/ttsService.js";

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

async function init() {
  await loadGeminiKey();
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
    tts: config.ttsEnabled
      ? {
          synthesize: createPollySynthesizer({ voice: config.pollyVoice, engine: config.pollyEngine, region: config.pollyRegion || undefined }),
          charsPerDay: config.ttsCharsPerDay,
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
    flushWaitMs: LIMITS.requestTimeoutMs * 2,
  });
}

// Cached across warm invocations; a failed init is retried on the next request.
let app: ReturnType<typeof init> | undefined;

export async function handler(event: UrlEvent): Promise<UrlResult> {
  app ??= init().catch((err) => {
    app = undefined;
    throw err;
  });
  return (await app)(event);
}
