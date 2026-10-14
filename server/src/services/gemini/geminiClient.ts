import { ApiError, GoogleGenAI, ThinkingLevel, type ThinkingConfig } from "@google/genai";
import type { z } from "zod";
import { config, LIMITS } from "../../config.js";
import { GeminiBudget, sleep } from "../rateLimiter.js";
import { AppError, classifyGeminiError, isRetryable } from "./geminiErrors.js";
import { toGeminiSchema } from "./geminiSchemas.js";

// The only place in the app that talks to Gemini. The API key lives in the
// server's environment and never leaves this process.

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (!config.geminiApiKey) {
    throw new AppError(
      "GEMINI_AUTH",
      "GEMINI_API_KEY is not set. Copy server/.env.example to server/.env and fill it in.",
      500
    );
  }
  client ??= new GoogleGenAI({ apiKey: config.geminiApiKey });
  return client;
}

const budget = new GeminiBudget(config.geminiRequestsPerMinute, config.geminiRequestsPerDay);

type ThinkingEffort = "minimal" | "low";

/**
 * Thinking tokens add latency and (on 2.5 models) eat into maxOutputTokens,
 * so live turns use the least thinking each model family allows.
 */
export function thinkingConfigFor(model: string, effort: ThinkingEffort): ThinkingConfig | undefined {
  if (config.geminiThinking === "off") return undefined;
  const m = model.replace(/^models\//, "");
  if (/^gemini-2\.5-flash/.test(m)) return { thinkingBudget: effort === "minimal" ? 0 : 1024 };
  if (/^gemini-2\.5-pro/.test(m)) return { thinkingBudget: effort === "minimal" ? 128 : 1024 };
  if (/^gemini-(1\.|2\.0)/.test(m)) return undefined;
  // Gemini 3+ and the *-latest aliases use thinking levels. Pro models
  // don't accept MINIMAL.
  if (/pro/.test(m)) return { thinkingLevel: ThinkingLevel.LOW };
  return { thinkingLevel: effort === "minimal" ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW };
}

export interface StructuredRequest<S extends z.ZodType> {
  /** Short label for logs, e.g. "job_analysis". Never logs prompt content. */
  task: string;
  systemInstruction: string;
  prompt: string;
  schema: S;
  maxOutputTokens: number;
  timeoutMs?: number;
  temperature?: number;
  thinking?: ThinkingEffort;
  /** Cancels the call (and any pending retry) when aborted. */
  signal?: AbortSignal;
  /** Context-dependent validation; return a problem description to reject (and retry) the output. */
  check?: (data: z.output<S>) => string | null;
  /**
   * Streams the response and hands over the fields written before `beforeKey`
   * as soon as they are complete, while the rest is still being generated.
   * Needs `beforeKey` to be a top-level field late in the schema's order.
   * Called at most once per request; if the early part never validates, the
   * full output is still returned as usual.
   */
  early?: EarlyFields;
}

export interface EarlyFields<E extends z.ZodType = z.ZodType> {
  beforeKey: string;
  schema: E;
  check?: (data: z.output<E>) => string | null;
  onEarly: (data: z.output<E>) => void;
}

/** Erases the early schema's type so requests can carry it (onEarly gets that schema's output). */
export function earlyFields<E extends z.ZodType>(early: EarlyFields<E>): EarlyFields {
  return early as unknown as EarlyFields;
}

/**
 * If the streamed JSON text has reached top-level `"beforeKey":`, returns the
 * object made of the fields before it. Inside JSON strings a quote is always
 * escaped, so `, "key":` can't match string content.
 */
export function parseFieldsBefore(partial: string, beforeKey: string): unknown | undefined {
  const match = new RegExp(`,\\s*"${beforeKey}"\\s*:`).exec(partial);
  if (!match) return undefined;
  try {
    return JSON.parse(`${partial.slice(0, match.index)}}`);
  } catch {
    return undefined;
  }
}

function tryEarly(early: EarlyFields, partial: string): boolean {
  const raw = parseFieldsBefore(partial, early.beforeKey);
  if (raw === undefined) return false;
  const parsed = early.schema.safeParse(raw);
  if (!parsed.success || early.check?.(parsed.data)) return false;
  early.onEarly(parsed.data);
  return true;
}

/** Function signature the interview service depends on — swapped for a fake in tests. */
export type GenerateStructured = <S extends z.ZodType>(req: StructuredRequest<S>) => Promise<z.output<S>>;

const schemaCache = new WeakMap<z.ZodType, Record<string, unknown>>();
function jsonSchemaFor(schema: z.ZodType) {
  let cached = schemaCache.get(schema);
  if (!cached) {
    cached = toGeminiSchema(schema);
    schemaCache.set(schema, cached);
  }
  return cached;
}

const BLOCKED_FINISH_REASONS = new Set([
  "SAFETY",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "RECITATION",
  "IMAGE_SAFETY",
]);

type GenerateParams = Parameters<GoogleGenAI["models"]["generateContent"]>[0];
type GenerateResult = Awaited<ReturnType<GoogleGenAI["models"]["generateContent"]>>;

/**
 * Streams a generation, firing `early` once its fields are complete. Returns
 * the last chunk (it carries usage and finish reason) plus the whole text.
 */
async function streamWithEarly(
  request: GenerateParams,
  early: EarlyFields,
  started: number,
  task: string
): Promise<{ response: GenerateResult; text: string }> {
  let text = "";
  let last: GenerateResult | undefined;
  let earlyDone = false;
  for await (const chunk of await getClient().models.generateContentStream(request)) {
    last = chunk;
    text += chunk.text ?? "";
    if (!earlyDone && tryEarly(early, text)) {
      earlyDone = true;
      console.log(`[gemini] ${task} early fields ready after ${Date.now() - started}ms`);
    }
  }
  if (!last) throw new AppError("GEMINI_EMPTY_RESPONSE", "The interviewer returned an empty response.", 502, true);
  return { response: last, text };
}

async function attempt<S extends z.ZodType>(
  req: StructuredRequest<S>,
  model: string = config.geminiModel
): Promise<z.output<S>> {
  const timeoutMs = req.timeoutMs ?? LIMITS.requestTimeoutMs;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout.signal]) : timeout.signal;
  const started = Date.now();

  try {
    await budget.acquire(req.signal);
    if (signal.aborted) throw new Error("aborted before request");
    const request = {
      model,
      contents: [{ role: "user", parts: [{ text: req.prompt }] }],
      config: {
        systemInstruction: req.systemInstruction,
        responseMimeType: "application/json",
        responseJsonSchema: jsonSchemaFor(req.schema),
        maxOutputTokens: req.maxOutputTokens,
        temperature: req.temperature ?? 0.4,
        thinkingConfig: thinkingConfigFor(model, req.thinking ?? "minimal"),
        abortSignal: signal,
        // We run our own retry loop (with Retry-After + budget accounting).
        httpOptions: { retryOptions: { attempts: 1 } },
      },
    };
    const { response, text } = req.early
      ? await streamWithEarly(request, req.early, started, req.task)
      : await getClient()
          .models.generateContent(request)
          .then((r) => ({ response: r, text: r.text ?? "" }));

    const usage = response.usageMetadata;
    console.log(
      `[gemini] ${req.task} model=${model} ${Date.now() - started}ms in=${usage?.promptTokenCount ?? "?"} out=${
        usage?.candidatesTokenCount ?? "?"
      }`
    );

    if (response.promptFeedback?.blockReason) {
      throw new AppError(
        "GEMINI_SAFETY_BLOCKED",
        "Gemini declined to process this content. Try rephrasing your answer.",
        422
      );
    }
    const candidate = response.candidates?.[0];
    const finishReason = candidate?.finishReason ? String(candidate.finishReason) : undefined;
    if (finishReason && BLOCKED_FINISH_REASONS.has(finishReason)) {
      throw new AppError(
        "GEMINI_SAFETY_BLOCKED",
        "Gemini declined to respond to this content. Try rephrasing your answer.",
        422
      );
    }

    const raw = text.trim();
    if (!raw) {
      throw new AppError("GEMINI_EMPTY_RESPONSE", "The interviewer returned an empty response.", 502, true);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const truncated = finishReason === "MAX_TOKENS" ? " (output hit the token limit)" : "";
      console.warn(`[gemini] ${req.task}: invalid JSON${truncated}`);
      throw new AppError("GEMINI_INVALID_OUTPUT", "The interviewer returned malformed output.", 502, true);
    }

    const result = req.schema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      console.warn(`[gemini] ${req.task}: schema validation failed — ${issues}`);
      throw new AppError("GEMINI_INVALID_OUTPUT", "The interviewer returned malformed output.", 502, true);
    }
    const problem = req.check?.(result.data);
    if (problem) {
      console.warn(`[gemini] ${req.task}: output rejected — ${problem}`);
      throw new AppError("GEMINI_INVALID_OUTPUT", "The interviewer returned an unusable response.", 502, true);
    }
    return result.data;
  } catch (err) {
    if (req.signal?.aborted) throw new AppError("CANCELLED", "The request was cancelled.", 499);
    if (timeout.signal.aborted && !(err instanceof AppError)) {
      throw new AppError("GEMINI_TIMEOUT", "The interviewer took too long to respond.", 504, true);
    }
    if (!(err instanceof AppError)) {
      // Upstream error text only (status + Google's message) — never prompt content.
      const status = err instanceof ApiError ? err.status : "network";
      const detail = err instanceof Error ? err.message.replace(/\s+/g, " ").slice(0, 240) : String(err);
      console.warn(`[gemini] ${req.task}: upstream error (${status}) ${detail}`);
    }
    throw classifyGeminiError(err, model);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Calls Gemini for a JSON response validated by `schema`. Retries at most
 * LIMITS.maxRetries times on 429/5xx/timeouts/malformed output, with
 * exponential backoff that honours Gemini's requested retry delay.
 */
export const generateStructured: GenerateStructured = async (req) => {
  let lastError: AppError | undefined;
  for (let i = 0; i <= LIMITS.maxRetries; i++) {
    try {
      // An overloaded primary model (503) often clears faster on another model.
      const useFallback =
        lastError?.code === "GEMINI_UNAVAILABLE" &&
        config.geminiFallbackModel &&
        config.geminiFallbackModel !== config.geminiModel;
      return await attempt(req, useFallback ? config.geminiFallbackModel : config.geminiModel);
    } catch (err) {
      const appErr = err instanceof AppError ? err : classifyGeminiError(err, config.geminiModel);
      lastError = appErr;
      if (!isRetryable(appErr) || i === LIMITS.maxRetries) throw appErr;

      const backoff = 1000 * 2 ** i + Math.floor(Math.random() * 400);
      const requested = appErr.retryAfterSeconds ? appErr.retryAfterSeconds * 1000 : 0;
      const wait = Math.max(backoff, requested);
      // A long quota window (e.g. a daily limit) won't clear by waiting here.
      if (wait > LIMITS.maxRetryWaitMs) throw appErr;
      console.warn(`[gemini] ${req.task}: ${appErr.code}, retry ${i + 1}/${LIMITS.maxRetries} in ${wait}ms`);
      await sleep(wait, req.signal);
    }
  }
  throw lastError ?? new AppError("INTERNAL_ERROR", "Unexpected Gemini failure.", 500);
};

/**
 * Proves the configured model can actually generate for this key. Model
 * listing isn't enough: retired models (e.g. gemini-2.5-flash for new keys)
 * still appear in models.list/get but 404 on generateContent.
 */
export async function verifyGeminiModel(): Promise<{ ok: true } | { ok: false; fatal: boolean; message: string }> {
  if (!config.geminiApiKey) {
    return { ok: false, fatal: true, message: "GEMINI_API_KEY is not set in server/.env." };
  }
  try {
    await getClient().models.generateContent({
      model: config.geminiModel,
      contents: "ping",
      config: {
        maxOutputTokens: 1,
        thinkingConfig: thinkingConfigFor(config.geminiModel, "minimal"),
        httpOptions: { retryOptions: { attempts: 1 }, timeout: 15_000 },
      },
    });
    return { ok: true };
  } catch (err) {
    const appErr = classifyGeminiError(err, config.geminiModel);
    const fatal = appErr.code === "GEMINI_MODEL_UNAVAILABLE" || appErr.code === "GEMINI_AUTH";
    return { ok: false, fatal, message: appErr.message };
  }
}
