import type {
  AnswerEvaluation,
  CandidateProfile,
  EvidenceLedgerItem,
  InterviewBlueprint,
  InterviewMode,
  InterviewQuestion,
  InterviewReport,
  InterviewerPersona,
  JobProfile,
  RespondResponse,
  StartResponse,
  TranscriptTurn,
} from "../../../shared/interviewTypes.js";
import { LIMITS } from "../config.js";
import { AppError } from "../services/gemini/geminiErrors.js";

export interface EvaluatedAnswer {
  questionId: string;
  competency: string;
  answerTurnId: string;
  evaluation: AnswerEvaluation;
}

/**
 * Server-side interview state. The browser only ever holds ids and display
 * data; everything Gemini sees is assembled from here.
 */
export interface InterviewSession {
  sessionId: string;
  status: "prepared" | "active" | "finished" | "expired";
  jobProfile: JobProfile;
  candidateProfile: CandidateProfile;
  blueprint: InterviewBlueprint;
  interviewMode: InterviewMode;
  /** Kept server-side only, for verifying report facts against the CV. */
  resumeText: string;
  persona: InterviewerPersona;
  transcript: TranscriptTurn[];
  questions: InterviewQuestion[];
  evaluations: EvaluatedAnswer[];
  ledger: EvidenceLedgerItem[];
  currentStage: string;
  currentQuestion?: InterviewQuestion;
  /** Turn of the current question (1 = first question); advances only after a valid Gemini response. */
  turnId: number;
  /** Follow-ups asked on the current root question. */
  followUpsUsed: number;
  questionCount: number;
  competenciesCovered: string[];
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  lastActivityAt: string;
  endedEarlyByCandidate: boolean;
  geminiCalls: number;

  // Request de-duplication (React Strict Mode, double clicks, retries).
  startPromise?: Promise<StartResponse>;
  startResponse?: StartResponse;
  /** The one Gemini request allowed for the current turn. */
  inFlight?: {
    key: string;
    controller: AbortController;
    promise: Promise<RespondResponse>;
  };
  /** Committed responses by `${turnId}:${questionId}` — replayed for duplicate submissions. */
  responses: Map<string, RespondResponse>;
  reportPromise?: Promise<InterviewReport>;
  report?: InterviewReport;
  reportError?: AppError;
}

export class SessionStore {
  private readonly sessions = new Map<string, InterviewSession>();

  constructor(private readonly now: () => number = Date.now) {}

  startSweeper() {
    setInterval(() => this.sweep(), 60_000).unref();
  }

  set(session: InterviewSession) {
    this.sessions.set(session.sessionId, session);
  }

  /** Throws SESSION_NOT_FOUND / SESSION_EXPIRED with user-facing messages. */
  get(sessionId: string): InterviewSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new AppError(
        "SESSION_NOT_FOUND",
        "This interview session no longer exists on the server (it may have been restarted). Please start a new interview.",
        404
      );
    }
    this.expireIfIdle(session);
    if (session.status === "expired") {
      throw new AppError("SESSION_EXPIRED", "This interview session expired after a period of inactivity.", 410);
    }
    return session;
  }

  delete(sessionId: string) {
    this.sessions.delete(sessionId);
  }

  peek(sessionId: string) {
    return this.sessions.get(sessionId);
  }

  touch(session: InterviewSession) {
    session.lastActivityAt = new Date(this.now()).toISOString();
  }

  private expireIfIdle(session: InterviewSession) {
    if (session.status === "finished" || session.status === "expired") return;
    const idle = this.now() - Date.parse(session.lastActivityAt);
    if (idle > LIMITS.sessionIdleTtlMs) {
      session.status = "expired";
      session.inFlight?.controller.abort();
    }
  }

  sweep() {
    const t = this.now();
    for (const [id, s] of this.sessions) {
      this.expireIfIdle(s);
      const age = t - Date.parse(s.lastActivityAt);
      if ((s.status === "finished" || s.status === "expired") && age > LIMITS.finishedSessionTtlMs) {
        this.sessions.delete(id);
      }
    }
  }
}

/** Counts a Gemini call against the per-session budget. */
export function chargeGeminiCall(session: InterviewSession, reserveForReport = true) {
  const limit = LIMITS.maxGeminiCallsPerSession - (reserveForReport ? 2 : 0);
  if (session.geminiCalls >= limit) {
    throw new AppError(
      "SESSION_LIMIT_REACHED",
      "This interview reached its AI request limit. End the interview to get your report.",
      429
    );
  }
  session.geminiCalls++;
}
