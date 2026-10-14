import type { InterviewService } from "../interview/interviewService.js";
import {
  analyzeRequestSchema,
  finishRequestSchema,
  respondRequestSchema,
  startRequestSchema,
} from "../interview/inputSchemas.js";
import type { SessionStore } from "../interview/session.js";
import type { DynamoStore } from "../persistence/dynamoStore.js";
import { errorBody, toAppError } from "../routes/apiErrors.js";
import { AppError } from "../services/gemini/geminiErrors.js";

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
  /** Longest wait for answer evaluations that finish after the reply. */
  flushWaitMs: number;
  maxBodyBytes?: number;
}

/** Approximate Gemini calls each route spends, for the daily budget. */
const ROUTE_COST = { analyze: 3, start: 1, respond: 1, finish: 1 } as const;
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
      const perIp = await db.incrementCounter(`ip#${ip}`, 60, 1);
      if (perIp.total > opts.httpRequestsPerMinutePerIp) {
        throw new AppError("RATE_LIMITED", "Too many requests. Please slow down.", 429, true, perIp.retryAfterSeconds);
      }
      if (opts.geminiCallsPerDay > 0) {
        const day = await db.incrementCounter("gemini-day", 86_400, ROUTE_COST[route]);
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

  async function persist(sessionId: string, version: number) {
    const session = store.peek(sessionId);
    if (!session) return;
    await service.flushBackground(sessionId, opts.flushWaitMs);
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

      const match = /^\/api\/interview\/(analyze|start|respond|finish)$/.exec(path);
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
