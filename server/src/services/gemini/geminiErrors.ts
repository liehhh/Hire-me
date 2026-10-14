import { ApiError } from "@google/genai";
import type { ApiErrorCode } from "../../../../shared/interviewTypes.js";

/** Application-level error with a stable code the frontend can act on. */
export class AppError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly httpStatus: number,
    readonly retryable = false,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const INTERVIEWER_UNAVAILABLE_MESSAGE =
  "The interviewer is temporarily unavailable. Your answer has been saved. Retry when ready.";

/**
 * Parses how long Gemini asked us to wait. 429 bodies carry either a
 * google.rpc.RetryInfo `"retryDelay": "37s"` or prose like
 * "Please retry in 5h43m49.3s".
 */
export function parseRetryAfterMs(message: string): number | undefined {
  const rpc = message.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (rpc) return Math.ceil(Number(rpc[1]) * 1000);

  const prose = message.match(/retry in ((?:\d+h)?(?:\d+m)?(?:\d+(?:\.\d+)?s)?)/i);
  if (prose && prose[1]) {
    const h = Number(prose[1].match(/(\d+)h/)?.[1] ?? 0);
    const m = Number(prose[1].match(/(\d+)m(?!s)/)?.[1] ?? 0);
    const s = Number(prose[1].match(/(\d+(?:\.\d+)?)s/)?.[1] ?? 0);
    const total = ((h * 60 + m) * 60 + s) * 1000;
    return total > 0 ? Math.ceil(total) : undefined;
  }
  return undefined;
}

/** Gemini reports "limit: 0" when a model has no free-tier quota at all. */
function isZeroQuota(message: string): boolean {
  return /limit:\s*0\b/.test(message);
}

/** Maps anything thrown by the SDK (or fetch) to an AppError. */
export function classifyGeminiError(err: unknown, model: string): AppError {
  if (err instanceof AppError) return err;

  if (err instanceof ApiError) {
    const msg = err.message ?? "";
    switch (err.status) {
      case 429: {
        if (isZeroQuota(msg)) {
          return new AppError(
            "GEMINI_MODEL_UNAVAILABLE",
            `The configured Gemini model "${model}" has no free-tier quota for this API key. Set GEMINI_MODEL to a model available on your plan.`,
            503
          );
        }
        const retryAfterMs = parseRetryAfterMs(msg);
        return new AppError(
          "RATE_LIMITED",
          "Gemini's free-tier rate limit was reached. Your answer has been saved. Retry when ready.",
          429,
          true,
          retryAfterMs ? Math.ceil(retryAfterMs / 1000) : undefined
        );
      }
      case 400:
        if (/api key not valid|API_KEY_INVALID/i.test(msg)) {
          return new AppError("GEMINI_AUTH", "The server's Gemini API key is invalid.", 500);
        }
        return new AppError("INTERNAL_ERROR", "Gemini rejected the request.", 502);
      case 401:
      case 403:
        return new AppError("GEMINI_AUTH", "The server's Gemini API key was rejected.", 500);
      case 404:
        return new AppError(
          "GEMINI_MODEL_UNAVAILABLE",
          `The configured Gemini model "${model}" is not available for this API key. Set GEMINI_MODEL to an available model.`,
          503
        );
      case 408:
      case 504:
        return new AppError("GEMINI_TIMEOUT", INTERVIEWER_UNAVAILABLE_MESSAGE, 504, true);
      default:
        if (err.status >= 500) {
          return new AppError("GEMINI_UNAVAILABLE", INTERVIEWER_UNAVAILABLE_MESSAGE, 503, true);
        }
    }
  }

  if (err instanceof Error && (err.name === "AbortError" || /aborted/i.test(err.message))) {
    return new AppError("CANCELLED", "The request was cancelled.", 499, true);
  }

  // fetch network failures surface as TypeError("fetch failed").
  return new AppError("GEMINI_UNAVAILABLE", INTERVIEWER_UNAVAILABLE_MESSAGE, 503, true);
}

/** Whether our own retry loop should try again. */
export function isRetryable(err: AppError): boolean {
  return (
    err.code === "RATE_LIMITED" ||
    err.code === "GEMINI_UNAVAILABLE" ||
    err.code === "GEMINI_TIMEOUT" ||
    err.code === "GEMINI_INVALID_OUTPUT" ||
    err.code === "GEMINI_EMPTY_RESPONSE"
  );
}
