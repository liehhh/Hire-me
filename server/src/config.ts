import "dotenv/config";

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number (got "${raw}").`);
  return Math.floor(n);
}

export const config = {
  port: intEnv("PORT", 4001),
  clientOrigin: process.env.CLIENT_ORIGIN ?? "http://localhost:5173",
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  geminiModel: (process.env.GEMINI_MODEL ?? "gemini-2.5-flash").trim(),
  /** Tried on retries when the primary model returns 503 (overloaded). Empty disables. */
  geminiFallbackModel: (process.env.GEMINI_FALLBACK_MODEL ?? "gemini-flash-latest").trim(),
  /** "auto" picks a low-thinking setting per model family; "off" sends no thinkingConfig. */
  geminiThinking: (process.env.GEMINI_THINKING ?? "auto").trim().toLowerCase(),
  /** Sends one tiny generation request at boot to prove the model works for this key. */
  geminiStartupCheck: (process.env.GEMINI_STARTUP_CHECK ?? "true").toLowerCase() !== "false",
  /** Global Gemini request budget for this process. 0 disables the daily cap. */
  geminiRequestsPerMinute: intEnv("GEMINI_RPM", 8),
  geminiRequestsPerDay: intEnv("GEMINI_RPD", 0),
  /** The interviewer's voice (Deepgram Aura). Disabled when there is no key. */
  ttsEnabled: (process.env.TTS_ENABLED ?? "true").toLowerCase() !== "false",
  deepgramApiKey: process.env.DEEPGRAM_API_KEY ?? "",
  deepgramModel: (process.env.DEEPGRAM_MODEL ?? "aura-2-thalia-en").trim(),
  /** Whole-deployment daily cap on characters sent to the voice service. 0 disables the cap. */
  ttsCharsPerDay: intEnv("TTS_CHARS_PER_DAY", 50_000),
};

// Hard limits protecting the Gemini free tier. Every Gemini call and every
// interview is bounded by these, regardless of what the model asks for.
export const LIMITS = {
  maxQuestions: intEnv("MAX_QUESTIONS", 30),
  maxInterviewMinutes: intEnv("MAX_INTERVIEW_MINUTES", 90),
  /** ~30 minutes of continuous speech — long answers are never cut short. */
  maxAnswerCharacters: 60_000,
  maxJobDescriptionCharacters: 30_000,
  maxResumeCharacters: 30_000,
  minJobDescriptionCharacters: 50,
  /** Analysis + blueprint calls. */
  maxOutputTokens: 1_500,
  /** Profile analysis is denser than a live turn. */
  analysisMaxOutputTokens: 3_000,
  /** Per-turn JSON (evaluation + next question). The spoken part is capped separately. */
  liveTurnMaxOutputTokens: 1_200,
  /** The spoken reply alone (summary, acknowledgement, next question): small, so it comes back fast. */
  liveReplyMaxOutputTokens: 600,
  /** Spoken text budget — the voice should never be handed a monologue. */
  liveResponseMaxTokens: 300,
  reportMaxOutputTokens: intEnv("REPORT_MAX_OUTPUT_TOKENS", 8_192),
  requestTimeoutMs: intEnv("GEMINI_TIMEOUT_MS", 20_000),
  reportTimeoutMs: intEnv("GEMINI_REPORT_TIMEOUT_MS", 90_000),
  maxRetries: 2,
  /** Don't sit in a retry loop for long quota windows; surface them to the user. */
  maxRetryWaitMs: 20_000,
  maxGeminiCallsPerSession: 60,
  sessionIdleTtlMs: 45 * 60_000,
  finishedSessionTtlMs: 3 * 60 * 60_000,
  /** Per-IP HTTP limit on /api/interview/*. */
  httpRequestsPerMinutePerIp: 60,
};

/** Rough spoken length cap (~4 chars/token) for text handed to the voice. */
export const MAX_SPOKEN_CHARACTERS = LIMITS.liveResponseMaxTokens * 4;
