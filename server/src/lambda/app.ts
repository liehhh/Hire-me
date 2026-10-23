import type { InterviewService } from "../interview/interviewService.js";
import {
  analyzeRequestSchema,
  evaluateRequestSchema,
  finishRequestSchema,
  respondRequestSchema,
  startRequestSchema,
} from "../interview/inputSchemas.js";
import type { SessionStore } from "../interview/session.js";
import type { DynamoStore } from "../persistence/dynamoStore.js";
import { errorBody, toAppError } from "../routes/apiErrors.js";
import { AppError } from "../services/gemini/geminiErrors.js";
import { issueSttToken, type SttTokenIssuer } from "../services/stt/sttService.js";
import { speak, ttsRequestSchema, type SpeechSynthesizer } from "../services/tts/ttsService.js";

/** The subset of a Lambda Function URL (payload v2) event this app reads. */
export interface UrlEvent {
  rawPath: string;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string; sourceIp?: string } };
}

export interface UrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export interface LambdaAppOptions {
  service: InterviewService;
  store: SessionStore;
  db: DynamoStore;
  /** Model name for /api/health. */
  model: string;
  httpRequestsPerMinutePerIp: number;
  /** Gemini-call budget for the whole deployment per UTC day; 0 = unlimited. */
  geminiCallsPerDay: number;
  sessionTtlMs: number;
  maxBodyBytes?: number;
  /** Live transcription for the candidate's voice. Omit to answer /api/stt/token with 404. */
  stt?: {
    issue: SttTokenIssuer;
    model: string;
    /** Transcription sessions per UTC day for the whole deployment; 0 = unlimited. */
    sessionsPerDay: number;
    requestsPerMinutePerIp: number;
  };
  /** Cloud voice. Omit to answer /api/tts with 404. */
  tts?: {
    synthesize: SpeechSynthesizer;
    /** Characters per UTC day for the whole deployment; 0 = unlimited. */
    charsPerDay: number;
    requestsPerMinutePerIp: number;
  };
}

/** Approximate Gemini calls each route spends, for the daily budget. */
const ROUTE_COST = { analyze: 3, start: 1, respond: 1, evaluate: 1, finish: 1 } as const;
type Route = keyof typeof ROUTE_COST;

const json = (statusCode: number, body: unknown, extra: Record<string, string> = {}): UrlResult => ({
  statusCode,
  headers: { "content-type": "application/json", ...extra },
  body: JSON.stringify(body),
});

/**
 * Serverless counterpart of routes/interview.ts. Lambda instances share no
 * memory, so each request loads the session from DynamoDB, runs the unchanged
 * InterviewService against it, then writes it back.
 */
export function createLambdaApp(opts: LambdaAppOptions) {
  const { service, store, db } = opts;
  const maxBodyBytes = opts.maxBodyBytes ?? 512 * 1024;

  async function throttle(ip: string, route: Route) {
    try {
      // Both counters are independent writes, so they go out together.
      const [perIp, day] = await Promise.all([
        db.incrementCounter(`ip#${ip}`, 60, 1),
        opts.geminiCallsPerDay > 0 ? db.incrementCounter("gemini-day", 86_400, ROUTE_COST[route]) : undefined,
      ]);
      if (perIp.total > opts.httpRequestsPerMinutePerIp) {
        throw new AppError("RATE_LIMITED", "Too many requests. Please slow down.", 429, true, perIp.retryAfterSeconds);
      }
      if (day) {
        if (day.total > opts.geminiCallsPerDay) {
          throw new AppError(
            "RATE_LIMITED",
            "The daily interview budget for this app is used up. Try again tomorrow.",
            429,
            true,
            day.retryAfterSeconds
          );
        }
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      // A counter outage must not take the app down; the Gemini client still enforces its own limits.
      console.warn("[rate-limit] counter unavailable, allowing request:", err);
    }
  }

  /** Per-IP request rate plus a whole-deployment daily character budget (the voice is billed per character). */
  async function throttleTts(ip: string, characters: number) {
    const tts = opts.tts;
    if (!tts) return;
    try {
      const [perIp, day] = await Promise.all([
        db.incrementCounter(`tts-ip#${ip}`, 60, 1),
        tts.charsPerDay > 0 ? db.incrementCounter("tts-chars-day", 86_400, characters) : undefined,
      ]);
      if (perIp.total > tts.requestsPerMinutePerIp) {
        throw new AppError("RATE_LIMITED", "Too many requests. Please slow down.", 429, true, perIp.retryAfterSeconds);
      }
      if (day) {
        if (day.total > tts.charsPerDay) {
          throw new AppError(
            "RATE_LIMITED",
            "The daily voice budget for this app is used up. Continue in text mode or try again tomorrow.",
            429,
            false,
            day.retryAfterSeconds
          );
        }
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      console.warn("[rate-limit] tts counter unavailable, allowing request:", err);
    }
  }

  /** Per-IP request rate plus a whole-deployment daily budget of transcription sessions (billed per minute streamed). */
  async function throttleStt(ip: string) {
    const stt = opts.stt;
    if (!stt) return;
    try {
      const [perIp, day] = await Promise.all([
        db.incrementCounter(`stt-ip#${ip}`, 60, 1),
        stt.sessionsPerDay > 0 ? db.incrementCounter("stt-day", 86_400, 1) : undefined,
      ]);
      if (perIp.total > stt.requestsPerMinutePerIp) {
        throw new AppError("RATE_LIMITED", "Too many requests. Please slow down.", 429, true, perIp.retryAfterSeconds);
      }
      if (day && day.total > stt.sessionsPerDay) {
        throw new AppError(
          "RATE_LIMITED",
          "The daily voice-input budget for this app is used up. Type your answer or try again tomorrow.",
          429,
          false,
          day.retryAfterSeconds
        );
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      console.warn("[rate-limit] stt counter unavailable, allowing request:", err);
    }
  }

  async function persist(sessionId: string, version: number) {
    const session = store.peek(sessionId);
    if (!session) return;
    await db.save(session, version, opts.sessionTtlMs);
  }

  /** Loads -> runs -> saves, even when the run fails (e.g. a saved answer or a stored report error). */
  async function withSession<T extends { sessionId: string }>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const loaded = await db.load(sessionId);
    if (loaded) store.set(loaded.session);
    const version = loaded?.version ?? 0;
    let result: T | undefined;
    try {
      result = await run();
      return result;
    } finally {
      try {
        if (loaded) await persist(sessionId, version);
        // /start can rebuild a lost session under a new id from client-held profiles.
        if (result && result.sessionId !== sessionId) await persist(result.sessionId, 0);
      } finally {
        store.delete(sessionId);
        if (result) store.delete(result.sessionId);
      }
    }
  }

  /**
   * Scores an answer without holding the session: the (slow) Gemini call runs
   * on a read-only copy, then the result is committed to whatever the session
   * looks like by then, retrying if another request saved in between.
   */
  async function evaluate(body: unknown) {
    const input = evaluateRequestSchema.parse(body);
    const loaded = await db.load(input.sessionId);
    if (!loaded) throw new AppError("SESSION_NOT_FOUND", "This interview session no longer exists on the server.", 404);
    const result = await service.runEvaluation(loaded.session, input.questionId);
    const reply = { sessionId: input.sessionId, questionId: input.questionId, evaluated: Boolean(result) };
    if (!result) return reply;

    let current = loaded;
    for (let attempt = 0; ; attempt++) {
      service.applyEvaluation(current.session, result);
      try {
        await db.save(current.session, current.version, opts.sessionTtlMs);
        return reply;
      } catch (err) {
        const conflict = err instanceof AppError && err.httpStatus === 409;
        if (!conflict || attempt >= 2) throw err;
        const fresh = await db.load(input.sessionId);
        if (!fresh) throw err;
        current = fresh;
      }
    }
  }

  async function dispatch(route: Route, body: unknown): Promise<unknown> {
    switch (route) {
      case "analyze": {
        const result = await service.analyze(analyzeRequestSchema.parse(body));
        try {
          await persist(result.sessionId, 0);
        } finally {
          store.delete(result.sessionId);
        }
        return result;
      }
      case "start": {
        const input = startRequestSchema.parse(body);
        return withSession(input.sessionId, () => service.start(input));
      }
      case "respond": {
        const input = respondRequestSchema.parse(body);
        return withSession(input.sessionId, () => service.respond(input));
      }
      case "evaluate":
        return evaluate(body);
      case "finish": {
        const input = finishRequestSchema.parse(body);
        const { report } = await withSession(input.sessionId, async () => ({
          sessionId: input.sessionId,
          report: await service.finish(input),
        }));
        return { report };
      }
    }
  }

  return async function handle(event: UrlEvent): Promise<UrlResult> {
    const { method, sourceIp } = event.requestContext.http;
    const path = event.rawPath.replace(/\/+$/, "");
    try {
      if (method === "GET" && path === "/api/health") return json(200, { ok: true, model: opts.model });

      if (method === "POST" && path === "/api/stt/token") {
        if (!opts.stt) throw new AppError("VALIDATION_ERROR", "Not found.", 404);
        await throttleStt(sourceIp ?? "unknown");
        return json(200, await issueSttToken(opts.stt.issue, opts.stt.model));
      }

      if (method === "POST" && path === "/api/tts") {
        if (!opts.tts) throw new AppError("VALIDATION_ERROR", "Not found.", 404);
        const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : (event.body ?? "");
        if (Buffer.byteLength(raw) > 8 * 1024) throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);
        const body: unknown = raw ? JSON.parse(raw) : {};
        const { text } = ttsRequestSchema.parse(body);
        await throttleTts(sourceIp ?? "unknown", text.length);
        return json(200, await speak(opts.tts.synthesize, body));
      }

      const match = /^\/api\/interview\/(analyze|start|respond|evaluate|finish)$/.exec(path);
      if (method !== "POST" || !match) throw new AppError("VALIDATION_ERROR", "Not found.", 404);
      const route = match[1] as Route;

      const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : (event.body ?? "");
      if (Buffer.byteLength(raw) > maxBodyBytes) throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);

      await throttle(sourceIp ?? "unknown", route);
      return json(200, await dispatch(route, raw ? JSON.parse(raw) : {}));
    } catch (err) {
      const appErr = toAppError(err);
      return json(
        appErr.httpStatus,
        errorBody(appErr),
        appErr.retryAfterSeconds ? { "retry-after": String(appErr.retryAfterSeconds) } : {}
      );
    }
  };
}
