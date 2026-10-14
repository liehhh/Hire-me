import { gunzipSync, gzipSync } from "node:zlib";
import type { ApiErrorCode, InterviewReport, RespondResponse } from "../../../shared/interviewTypes.js";
import type { InterviewSession } from "../interview/session.js";
import { AppError } from "../services/gemini/geminiErrors.js";

// DynamoDB items are capped at 400 KB. A long interview (30 answers, resume,
// transcript) is mostly repetitive text, so gzip keeps it far below that.
export const MAX_ENCODED_BYTES = 380_000;

interface StoredError {
  code: ApiErrorCode;
  message: string;
  httpStatus: number;
  retryable: boolean;
  retryAfterSeconds?: number;
}

/** Runtime-only fields (live promises, abort controllers) never leave the process. */
type Persisted = Omit<
  InterviewSession,
  "startPromise" | "inFlight" | "pendingEvaluations" | "reportPromise" | "responses" | "reportError"
> & {
  responses: [string, RespondResponse][];
  reportError?: StoredError;
  report?: InterviewReport;
};

export function encodeSession(session: InterviewSession): Buffer {
  const { startPromise, inFlight, pendingEvaluations, reportPromise, responses, reportError, ...durable } = session;
  void startPromise, void inFlight, void pendingEvaluations, void reportPromise;
  const persisted: Persisted = {
    ...durable,
    responses: [...responses.entries()],
    reportError: reportError && {
      code: reportError.code,
      message: reportError.message,
      httpStatus: reportError.httpStatus,
      retryable: reportError.retryable,
      retryAfterSeconds: reportError.retryAfterSeconds,
    },
  };
  const encoded = gzipSync(JSON.stringify(persisted));
  if (encoded.length > MAX_ENCODED_BYTES) {
    throw new AppError("SESSION_LIMIT_REACHED", "This interview is too large to store. End it to get your report.", 413);
  }
  return encoded;
}

export function decodeSession(data: Uint8Array): InterviewSession {
  const p = JSON.parse(gunzipSync(data).toString("utf8")) as Persisted;
  const { responses, reportError, ...rest } = p;
  return {
    ...rest,
    responses: new Map(responses),
    reportError:
      reportError && new AppError(reportError.code, reportError.message, reportError.httpStatus, reportError.retryable, reportError.retryAfterSeconds),
  };
}
