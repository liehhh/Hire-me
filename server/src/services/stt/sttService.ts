import type { SttTokenResponse } from "../../../../shared/interviewTypes.js";
import { AppError } from "../gemini/geminiErrors.js";

/** Mints a short-lived credential the browser can open a Deepgram transcription socket with. */
export type SttTokenIssuer = () => Promise<{ token: string; expiresInSeconds: number }>;

export interface DeepgramTokenOptions {
  apiKey: string;
  /** The token only has to live until the socket is open; an open socket keeps running. */
  ttlSeconds?: number;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export function createDeepgramTokenIssuer(opts: DeepgramTokenOptions): SttTokenIssuer {
  const doFetch = opts.fetchFn ?? fetch;
  return async () => {
    const res = await doFetch("https://api.deepgram.com/v1/auth/grant", {
      method: "POST",
      headers: { Authorization: `Token ${opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl_seconds: opts.ttlSeconds ?? 120 }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new Error(`Deepgram responded ${res.status}: ${detail}`);
    }
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("Deepgram returned no access token.");
    return { token: body.access_token, expiresInSeconds: body.expires_in ?? opts.ttlSeconds ?? 120 };
  };
}

/** Issues a token for the browser. Failures become a retryable 502 (the client falls back to the browser's own speech recognition). */
export async function issueSttToken(issue: SttTokenIssuer, model: string): Promise<SttTokenResponse> {
  try {
    return { ...(await issue()), model };
  } catch (err) {
    console.error("[stt] could not issue a transcription token:", err);
    throw new AppError("INTERNAL_ERROR", "The speech service is unavailable.", 502, true);
  }
}
