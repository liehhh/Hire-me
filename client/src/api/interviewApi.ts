import type {
  AnalyzeRequest,
  AnalyzeResponse,
  ApiErrorBody,
  ApiErrorCode,
  FinishRequest,
  FinishResponse,
  RespondRequest,
  RespondResponse,
  StartRequest,
  StartResponse,
  TtsRequest,
  TtsResponse,
} from "../types";

// Thin typed client for the InterviewerAI backend. The browser only ever
// talks to our server; Gemini and its API key stay server-side.

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:4001";

export type ClientErrorCode = ApiErrorCode | "NETWORK";

export class ApiRequestError extends Error {
  constructor(
    readonly code: ClientErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export const isCancelled = (err: unknown) => err instanceof ApiRequestError && err.code === "CANCELLED";

async function postTo<T>(route: string, body: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${SERVER_URL}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw new ApiRequestError("CANCELLED", "Request cancelled.", false);
    throw new ApiRequestError(
      "NETWORK",
      "Can't reach the interview server. Check that it is running, then retry.",
      true
    );
  }

  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as ApiErrorBody | null;
    if (data?.error) {
      throw new ApiRequestError(data.error.code, data.error.message, data.error.retryable, data.error.retryAfterSeconds);
    }
    throw new ApiRequestError("INTERNAL_ERROR", `Server responded ${res.status}.`, res.status >= 500);
  }
  return (await res.json()) as T;
}

const post = <T>(path: string, body: unknown, signal?: AbortSignal) =>
  postTo<T>(`/api/interview/${path}`, body, signal);

export const interviewApi = {
  analyze: (body: AnalyzeRequest, signal?: AbortSignal) => post<AnalyzeResponse>("analyze", body, signal),
  start: (body: StartRequest, signal?: AbortSignal) => post<StartResponse>("start", body, signal),
  respond: (body: RespondRequest, signal?: AbortSignal) => post<RespondResponse>("respond", body, signal),
  finish: (body: FinishRequest, signal?: AbortSignal) => post<FinishResponse>("finish", body, signal),
  /** Cloud voice: one sentence in, base64 MP3 out. */
  speech: (body: TtsRequest, signal?: AbortSignal) => postTo<TtsResponse>("/api/tts", body, signal),
};
