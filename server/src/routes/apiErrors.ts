import { z } from "zod";
import type { ApiErrorBody } from "../../../shared/interviewTypes.js";
import { AppError } from "../services/gemini/geminiErrors.js";

/** Maps any thrown value to an AppError. Never leaks prompts or stack traces. */
export function toAppError(err: unknown): AppError {
  let appErr: AppError;
  if (err instanceof z.ZodError) {
    appErr = new AppError("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid request.", 400);
  } else if (err instanceof AppError) {
    appErr = err;
  } else if (err instanceof SyntaxError) {
    appErr = new AppError("VALIDATION_ERROR", "Request body is not valid JSON.", 400);
  } else {
    console.error("[api] unexpected error:", err);
    appErr = new AppError("INTERNAL_ERROR", "Something went wrong on the server.", 500, true);
  }

  // Expected client-flow outcomes (stale/empty/duplicate/validation) are
  // returned to the client, not logged — only throttling and server-side
  // failures are worth a warning.
  if (appErr.httpStatus >= 500 || appErr.httpStatus === 429) {
    console.warn(`[api] ${appErr.httpStatus} ${appErr.code}: ${appErr.message}`);
  }
  return appErr;
}

export function errorBody(appErr: AppError): ApiErrorBody {
  return {
    error: {
      code: appErr.code,
      message: appErr.message,
      retryable: appErr.retryable,
      retryAfterSeconds: appErr.retryAfterSeconds,
    },
  };
}
