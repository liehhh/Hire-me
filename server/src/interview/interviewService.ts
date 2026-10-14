import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";
import type {
  AnalyzeResponse,
  CandidateProfile,
  FinishRequest,
  InterviewQuestion,
  InterviewReport,
  RespondRequest,
  RespondResponse,
  StartResponse,
  TranscriptTurn,
} from "../../../shared/interviewTypes.js";
import { LIMITS, MAX_SPOKEN_CHARACTERS } from "../config.js";
import { earlyFields, type GenerateStructured } from "../services/gemini/geminiClient.js";
import { AppError } from "../services/gemini/geminiErrors.js";
import {
  candidateAnalysisPrompt,
  finalReportPrompt,
  firstQuestionPrompt,
  interviewBlueprintPrompt,
  jobAnalysisPrompt,
  liveTurnPrompt,
} from "../services/gemini/geminiPrompts.js";
import {
  blueprintOutputSchema,
  candidateAnalysisOutputSchema,
  firstQuestionOutputSchema,
  jobAnalysisOutputSchema,
  LIVE_TURN_EVALUATION_KEY,
  liveTurnOutputSchema,
  liveTurnReplySchema,
  reportOutputSchema,
  type LiveTurnOutput,
  type LiveTurnReply,
  type QuestionDraft,
} from "../services/gemini/geminiSchemas.js";
import { durationRangeFor, matchCompetency, normalizeBlueprint, targetDuration } from "./blueprint.js";
import {
  allowedActions,
  coverageSummary,
  pacing,
  progressOf,
  resolveCompetency,
  updateLedger,
} from "./flow.js";
import type { analyzeRequestSchema, startRequestSchema } from "./inputSchemas.js";
import { buildValidatedReport, emptyReport, type AnsweredQuestion } from "./report.js";
import { chargeGeminiCall, type InterviewSession, type SessionStore } from "./session.js";
import { similarity, truncate } from "./text.js";

type AnalyzeInput = z.output<typeof analyzeRequestSchema>;
type StartInput = z.output<typeof startRequestSchema>;

const PERSONA = { name: "Maya", title: "Interviewer" };

const CLOSING_FALLBACK =
  "Thank you, that brings us to the end of the interview. I'll put together your feedback report now.";

const EMPTY_CANDIDATE: CandidateProfile = {
  hasResume: false,
  claimedSkills: [],
  skillEvidence: [],
  claimedExperience: [],
  projects: [],
  measurableAchievements: [],
  industries: [],
  senioritySignals: [],
  unclearClaims: [],
  missingEvidenceForJobRequirements: [],
};

const ANALYSIS_TIMEOUT_MS = Math.max(LIMITS.requestTimeoutMs, 30_000);

/** Waits for background evaluations, but never longer than `maxWaitMs`. */
async function settleEvaluations(session: InterviewSession, maxWaitMs: number): Promise<void> {
  const pending = [...(session.pendingEvaluations ?? [])];
  if (!pending.length) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(pending),
    new Promise((resolve) => {
      timer = setTimeout(resolve, maxWaitMs);
    }),
  ]);
  clearTimeout(timer);
}

/** Joins spoken parts and keeps the result short enough for Kokoro. */
function spoken(...parts: (string | null | undefined)[]): string {
  const clean = parts.map((p) => (p ?? "").replace(/[*_#`>]/g, "").trim()).filter(Boolean);
  let text = clean.join(" ");
  // Drop the acknowledgement before ever truncating the question itself.
  if (text.length > MAX_SPOKEN_CHARACTERS && clean.length > 1) text = clean.slice(1).join(" ");
  return truncate(text, MAX_SPOKEN_CHARACTERS);
}

export class InterviewService {
  private readonly analyzeInFlight = new Map<string, Promise<AnalyzeResponse>>();

  constructor(
    private readonly generate: GenerateStructured,
    private readonly store: SessionStore,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * Waits for answer evaluations that are still streaming after their reply
   * was sent. A serverless runtime freezes background work once the response
   * is returned, so the Lambda handler calls this before persisting.
   */
  flushBackground(sessionId: string, maxWaitMs: number): Promise<void> {
    const session = this.store.peek(sessionId);
    return session ? settleEvaluations(session, maxWaitMs) : Promise.resolve();
  }

  private iso() {
    return new Date(this.now()).toISOString();
  }

  // -------------------------------------------------------------------------
  // POST /api/interview/analyze
  // -------------------------------------------------------------------------

  analyze(input: AnalyzeInput): Promise<AnalyzeResponse> {
    // Identical concurrent submissions (double click, Strict Mode) share one
    // analysis instead of spending three Gemini calls each.
    const key = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const existing = this.analyzeInFlight.get(key);
    if (existing) return existing;
    const promise = this.runAnalysis(input).finally(() => this.analyzeInFlight.delete(key));
    this.analyzeInFlight.set(key, promise);
    return promise;
  }

  private async runAnalysis(input: AnalyzeInput): Promise<AnalyzeResponse> {
    const job = await this.generate({
      task: "job_analysis",
      ...jobAnalysisPrompt({ ...input }),
      schema: jobAnalysisOutputSchema,
      maxOutputTokens: LIMITS.analysisMaxOutputTokens,
      timeoutMs: ANALYSIS_TIMEOUT_MS,
      thinking: "low",
      temperature: 0.2,
    });

    if (job.confidence < 0.2 && job.requiredSkills.length === 0 && job.coreResponsibilities.length === 0) {
      throw new AppError(
        "VALIDATION_ERROR",
        "That text doesn't look like a job description. Paste the full posting, including responsibilities and requirements.",
        422
      );
    }

    const candidate: CandidateProfile = input.resumeText
      ? {
          hasResume: true,
          ...(await this.generate({
            task: "candidate_analysis",
            ...candidateAnalysisPrompt({ resumeText: input.resumeText, job }),
            schema: candidateAnalysisOutputSchema,
            maxOutputTokens: LIMITS.analysisMaxOutputTokens,
            timeoutMs: ANALYSIS_TIMEOUT_MS,
            thinking: "low",
            temperature: 0.1,
          })),
        }
      : EMPTY_CANDIDATE;

    const window = targetDuration(job.seniority, input.preferredLength);
    const rawBlueprint = await this.generate({
      task: "interview_blueprint",
      ...interviewBlueprintPrompt({
        job,
        candidate,
        interviewMode: input.interviewMode,
        preferredLength: input.preferredLength,
        durationRange: durationRangeFor(job.seniority),
        targetMinutes: window.target,
        maxQuestions: LIMITS.maxQuestions,
      }),
      schema: blueprintOutputSchema,
      maxOutputTokens: LIMITS.analysisMaxOutputTokens,
      timeoutMs: ANALYSIS_TIMEOUT_MS,
      thinking: "low",
      temperature: 0.3,
    });
    const blueprint = normalizeBlueprint(rawBlueprint, job, input.preferredLength);

    const sessionId = randomUUID();
    const t = this.iso();
    this.store.set({
      sessionId,
      status: "prepared",
      jobProfile: job,
      candidateProfile: candidate,
      blueprint,
      interviewMode: input.interviewMode,
      resumeText: input.resumeText ?? "",
      persona: { ...PERSONA, title: `Interviewer · ${job.normalizedTitle}` },
      transcript: [],
      questions: [],
      evaluations: [],
      ledger: [],
      currentStage: blueprint.stages[0]?.name ?? "introduction",
      turnId: 0,
      followUpsUsed: 0,
      questionCount: 0,
      competenciesCovered: [],
      createdAt: t,
      lastActivityAt: t,
      endedEarlyByCandidate: false,
      geminiCalls: 3,
      responses: new Map(),
    });

    return { sessionId, jobProfile: job, candidateProfile: candidate, interviewBlueprint: blueprint };
  }

  // -------------------------------------------------------------------------
  // POST /api/interview/start
  // -------------------------------------------------------------------------

  async start(input: StartInput): Promise<StartResponse> {
    const session = this.store.peek(input.sessionId)
      ? this.store.get(input.sessionId)
      : this.restoreSession(input);

    if (session.startResponse) return session.startResponse;
    if (session.startPromise) return session.startPromise;
    if (session.status !== "prepared") {
      throw new AppError("SESSION_FINISHED", "This interview has already finished.", 409);
    }

    session.startPromise = this.runStart(session).finally(() => {
      session.startPromise = undefined;
    });
    return session.startPromise;
  }

  /** Rebuilds a session from client-held profiles, e.g. after a server restart. */
  private restoreSession(input: StartInput): InterviewSession {
    if (!input.jobProfile || !input.candidateProfile || !input.interviewBlueprint) {
      return this.store.get(input.sessionId); // throws SESSION_NOT_FOUND
    }
    const t = this.iso();
    const job = input.jobProfile;
    const blueprint = normalizeBlueprint(input.interviewBlueprint, job, "standard");
    const session: InterviewSession = {
      sessionId: randomUUID(),
      status: "prepared",
      jobProfile: job,
      candidateProfile: input.candidateProfile,
      blueprint,
      interviewMode: "mixed",
      resumeText: "",
      persona: { ...PERSONA, title: `Interviewer · ${job.normalizedTitle}` },
      transcript: [],
      questions: [],
      evaluations: [],
      ledger: [],
      currentStage: blueprint.stages[0]?.name ?? "introduction",
      turnId: 0,
      followUpsUsed: 0,
      questionCount: 0,
      competenciesCovered: [],
      createdAt: t,
      lastActivityAt: t,
      endedEarlyByCandidate: false,
      geminiCalls: 0,
      responses: new Map(),
    };
    this.store.set(session);
    return session;
  }

  private async runStart(session: InterviewSession): Promise<StartResponse> {
    chargeGeminiCall(session);
    const out = await this.generate({
      task: "first_question",
      ...firstQuestionPrompt({
        job: session.jobProfile,
        candidate: session.candidateProfile,
        blueprint: session.blueprint,
        persona: session.persona,
      }),
      schema: firstQuestionOutputSchema,
      maxOutputTokens: LIMITS.liveTurnMaxOutputTokens,
      temperature: 0.7,
    });

    const question = this.toQuestion(session, out.question, false);
    session.status = "active";
    session.startedAt = this.iso();
    session.currentQuestion = question;
    session.currentStage = question.stage;
    session.questions.push(question);
    session.questionCount = 1;
    const openingText = spoken(out.openingText);
    this.addTurn(session, "interviewer", spoken(openingText, question.text), question.id);
    this.store.touch(session);

    session.turnId = 1;
    session.startResponse = {
      sessionId: session.sessionId,
      turnId: 1,
      persona: session.persona,
      firstQuestion: question,
      openingText,
      progress: progressOf(session, this.now()),
    };
    return session.startResponse;
  }

  // -------------------------------------------------------------------------
  // POST /api/interview/respond
  // -------------------------------------------------------------------------

  /**
   * Evaluates the locked answer for exactly one turn. `(turnId, questionId)`
   * is the idempotency key: a duplicate submission (double click, network
   * retry, re-render) gets the same in-flight promise or the committed
   * response, and Gemini is called at most once per successful turn.
   */
  async respond(input: RespondRequest): Promise<RespondResponse> {
    const session = this.store.get(input.sessionId);
    const key = `${input.turnId}:${input.questionId}`;

    const committed = session.responses.get(key);
    if (committed) return committed;

    if (session.status === "finished") {
      throw new AppError("SESSION_FINISHED", "This interview has already finished.", 409);
    }
    if (session.status !== "active" || !session.currentQuestion) {
      throw new AppError("VALIDATION_ERROR", "The interview has not started yet.", 409);
    }
    if (input.turnId !== session.turnId) {
      throw new AppError(
        "STALE_QUESTION",
        `This answer was captured for turn ${input.turnId}, but the interview is on turn ${session.turnId}.`,
        409
      );
    }
    if (input.questionId !== session.currentQuestion.id) {
      throw new AppError("STALE_QUESTION", `This answer does not match the current question of turn ${session.turnId}.`, 409);
    }
    if (!input.candidateTranscript) {
      throw new AppError("EMPTY_ANSWER", "No answer was captured. Please answer the question.", 400);
    }

    // One Gemini request per turn: a duplicate joins the one already running.
    if (session.inFlight?.key === key) return session.inFlight.promise;

    // Save the answer under this exact question before calling Gemini, so a
    // failure never loses it and a retry re-uses it.
    const answerTurn = this.upsertAnswer(session, input.questionId, input.candidateTranscript);
    this.store.touch(session);

    const controller = new AbortController();
    const promise = this.runTurn(session, answerTurn, input.candidateTranscript, controller.signal).then((response) => {
      session.responses.set(key, response);
      return response;
    });
    session.inFlight = { key, controller, promise };
    try {
      return await promise;
    } finally {
      if (session.inFlight?.promise === promise) session.inFlight = undefined;
    }
  }

  private async runTurn(
    session: InterviewSession,
    answerTurn: TranscriptTurn,
    answer: string,
    signal: AbortSignal
  ): Promise<RespondResponse> {
    // The previous answer's evaluation feeds coverage and pacing. It almost
    // always finished while the candidate was talking.
    await settleEvaluations(session, 10_000);
    const now = this.now();
    const question = session.currentQuestion!;
    const pace = pacing(session, now, question.competency);
    const actions = allowedActions(session);
    chargeGeminiCall(session);

    const stage = session.blueprint.stages.find((s) => s.name === session.currentStage);
    const stageIndex = session.blueprint.stages.findIndex((s) => s.name === session.currentStage);
    const previousQuestions = session.questions.map((q) => q.text);

    const checkReply = (o: LiveTurnReply) => {
      const ending = pace.mustEnd || (pace.mayEnd && o.endInterview);
      if (!ending && !o.nextQuestion) return "no next question while the interview must continue";
      if (!ending && o.nextQuestion) {
        // A follow-up may rephrase the current question (e.g. "could you repeat that?").
        const asked = o.nextQuestion.isFollowUp ? previousQuestions.filter((p) => p !== question.text) : previousQuestions;
        const repeat = asked.find((p) => similarity(p, o.nextQuestion!.text) > 0.7);
        if (repeat) return "next question repeats an earlier question";
      }
      return null;
    };

    // One streamed Gemini call. The spoken reply is written first and is
    // used as soon as it is complete; the evaluation keeps streaming and is
    // committed in the background.
    let deliverReply!: (reply: LiveTurnReply) => void;
    const earlyReply = new Promise<LiveTurnReply>((resolve) => (deliverReply = resolve));
    const full: Promise<LiveTurnOutput> = this.generate({
      task: "live_turn",
      ...liveTurnPrompt({
        job: session.jobProfile,
        candidate: session.candidateProfile,
        blueprint: session.blueprint,
        persona: session.persona,
        currentQuestion: question,
        followUpsUsed: session.followUpsUsed,
        answer,
        recentTurns: session.transcript
          .filter((t) => t.id !== answerTurn.id)
          .slice(-4)
          .map((t) => ({ speaker: t.speaker, text: truncate(t.text, 600) })),
        previousQuestions: previousQuestions.slice(-15).map((q) => truncate(q, 140)),
        coverage: coverageSummary(session),
        currentStage: {
          name: session.currentStage,
          purpose: stage?.purpose ?? "",
          questionsAskedInStage: session.questions.filter((q) => q.stage === session.currentStage).length,
          plannedQuestions: stage?.questionCount ?? 0,
        },
        upcomingStages: session.blueprint.stages
          .slice(stageIndex + 1)
          .map((s) => ({ name: s.name, competencies: s.competencies })),
        priorityCompetencies: pace.uncovered,
        allowedActions: actions,
        mayEnd: pace.mayEnd,
        mustEnd: pace.mustEnd,
        elapsedMinutes: Math.round(pace.elapsed),
        plannedMinutes: pace.planned,
        estimatedQuestionsRemaining: Math.max(0, session.blueprint.totalQuestions - session.questionCount),
      }),
      schema: liveTurnOutputSchema,
      maxOutputTokens: LIMITS.liveTurnMaxOutputTokens,
      temperature: 0.5,
      signal,
      check: checkReply,
      early: earlyFields({
        beforeKey: LIVE_TURN_EVALUATION_KEY,
        schema: liveTurnReplySchema,
        check: checkReply,
        onEarly: deliverReply,
      }),
    });
    // Rejects only if Gemini fails before the reply was complete.
    const out = await Promise.race([earlyReply, full]);

    // The interview ended while Gemini was working — never commit a stale turn.
    const turnId = session.turnId;
    if (signal.aborted || session.status !== "active" || session.currentQuestion?.id !== question.id) {
      throw new AppError("CANCELLED", "The interview ended before this answer was processed.", 409);
    }

    // --- commit evaluation + evidence (in the background if still streaming)
    const commitEvaluation = (result: LiveTurnOutput) => {
      const competency = resolveCompetency(session, result.competencyAssessed);
      session.evaluations = session.evaluations.filter((e) => e.questionId !== question.id);
      session.evaluations.push({
        questionId: question.id,
        competency,
        answerTurnId: answerTurn.id,
        evaluation: result.evaluation,
      });
      updateLedger(session, competency, result.evaluation, answerTurn.id);
      if (result.evaluation.relevance >= 2 && !session.competenciesCovered.includes(competency)) {
        session.competenciesCovered.push(competency);
      }
    };
    const complete = LIVE_TURN_EVALUATION_KEY in out ? (out as LiveTurnOutput) : null;
    if (complete) {
      commitEvaluation(complete);
    } else {
      const pending = (session.pendingEvaluations ??= new Set());
      const job: Promise<void> = full
        .then(commitEvaluation)
        .catch((err: unknown) => {
          const code = err instanceof AppError ? err.code : "UNKNOWN";
          console.warn(`[interview] evaluation for ${question.id} failed after the reply was sent (${code})`);
        })
        .finally(() => pending.delete(job));
      pending.add(job);
    }

    // --- decide continue / end (server rules win over the model)
    const ending = pace.mustEnd || (pace.mayEnd && out.endInterview);
    let nextAction = out.nextAction;
    let nextQuestion: InterviewQuestion | undefined;
    let conversationMessage: string;

    if (ending) {
      session.currentQuestion = undefined;
      session.currentStage = "closing";
      conversationMessage = spoken(out.closingMessage ?? CLOSING_FALLBACK);
    } else {
      let isFollowUp = out.nextQuestion!.isFollowUp || nextAction === "ask_follow_up" || nextAction === "clarify_claim";
      if (isFollowUp && !actions.includes("ask_follow_up")) {
        // Follow-up budget for this question is spent; treat it as a new topic.
        isFollowUp = false;
        nextAction = "move_to_next_competency";
      }
      nextQuestion = this.toQuestion(session, out.nextQuestion!, isFollowUp);
      session.followUpsUsed = isFollowUp ? session.followUpsUsed + 1 : 0;
      session.currentQuestion = nextQuestion;
      session.currentStage = nextQuestion.stage;
      session.questions.push(nextQuestion);
      session.questionCount++;
      conversationMessage = spoken(out.acknowledgement, nextQuestion.text);
    }

    // The turn advances only now, after a valid Gemini response was committed.
    session.turnId = turnId + 1;
    this.addTurn(session, "interviewer", conversationMessage, nextQuestion?.id);
    this.store.touch(session);

    const response: RespondResponse = {
      sessionId: session.sessionId,
      turnId,
      questionId: question.id,
      nextTurnId: ending ? null : turnId + 1,
      answerSummary: out.answerSummary,
      answerEvaluation: complete?.evaluation ?? null,
      nextAction,
      nextQuestion,
      shouldContinue: !ending,
      conversationMessage,
      progress: progressOf(session, this.now()),
    };
    return response;
  }

  // -------------------------------------------------------------------------
  // POST /api/interview/finish
  // -------------------------------------------------------------------------

  async finish(input: FinishRequest): Promise<InterviewReport> {
    const session = this.store.get(input.sessionId);
    if (session.report) return session.report;
    if (session.reportPromise) return session.reportPromise;
    // Never regenerate silently after a failure — that would spend quota on
    // every page refresh. The client must ask explicitly.
    if (session.reportError && !input.retry) throw session.reportError;

    if (session.status !== "finished") {
      session.endedEarlyByCandidate = session.currentQuestion !== undefined;
      session.status = "finished";
      session.endedAt = this.iso();
      session.inFlight?.controller.abort();
      this.mergeClientTranscript(session, input.transcript);
    }

    session.reportPromise = this.runReport(session)
      .then((report) => {
        session.report = report;
        session.reportError = undefined;
        return report;
      })
      .catch((err: unknown) => {
        session.reportError = err instanceof AppError ? err : new AppError("INTERNAL_ERROR", "Report failed.", 500, true);
        throw session.reportError;
      })
      .finally(() => {
        session.reportPromise = undefined;
      });
    return session.reportPromise;
  }

  /** Adds answers the client captured but never got to submit (e.g. ended mid-answer). */
  private mergeClientTranscript(session: InterviewSession, clientTurns: TranscriptTurn[]) {
    for (const turn of clientTurns) {
      if (turn.speaker !== "candidate" || !turn.questionId || !turn.text.trim()) continue;
      const known = session.questions.some((q) => q.id === turn.questionId);
      const answered = session.transcript.some((t) => t.speaker === "candidate" && t.questionId === turn.questionId);
      if (known && !answered) this.upsertAnswer(session, turn.questionId, turn.text.trim());
    }
  }

  private answeredQuestions(session: InterviewSession): AnsweredQuestion[] {
    return session.questions.flatMap((q) => {
      const answer = session.transcript.find((t) => t.speaker === "candidate" && t.questionId === q.id);
      return answer ? [{ questionId: q.id, question: q.text, competency: q.competency, difficulty: q.difficulty, answer: answer.text }] : [];
    });
  }

  private async runReport(session: InterviewSession): Promise<InterviewReport> {
    await settleEvaluations(session, LIMITS.requestTimeoutMs * 2);
    const answered = this.answeredQuestions(session);
    if (answered.length === 0) return emptyReport(session, this.now());

    // Keep the prompt bounded: later answers keep more detail, earlier ones
    // are trimmed first if the interview was very long.
    const budget = 120_000;
    const perAnswer = Math.max(1_500, Math.min(12_000, Math.floor(budget / answered.length)));
    const qa = answered.map((a) => ({
      questionId: a.questionId,
      question: a.question,
      competency: a.competency,
      answer: truncate(a.answer, perAnswer),
      evaluation: session.evaluations.find((e) => e.questionId === a.questionId)?.evaluation ?? "not evaluated (interview ended)",
    }));

    chargeGeminiCall(session, false);
    const raw = await this.generate({
      task: "final_report",
      ...finalReportPrompt({
        job: session.jobProfile,
        candidate: session.candidateProfile,
        blueprint: session.blueprint,
        qa,
        ledger: session.ledger,
        durationMinutes: Math.round((Date.parse(session.endedAt ?? this.iso()) - Date.parse(session.startedAt ?? this.iso())) / 60_000),
        endedEarlyByCandidate: session.endedEarlyByCandidate,
      }),
      schema: reportOutputSchema,
      maxOutputTokens: LIMITS.reportMaxOutputTokens,
      timeoutMs: LIMITS.reportTimeoutMs,
      thinking: "low",
      temperature: 0.2,
    });

    const endedAt = session.endedAt ? Date.parse(session.endedAt) : this.now();
    return buildValidatedReport(raw, session, answered, endedAt);
  }

  // -------------------------------------------------------------------------

  private toQuestion(session: InterviewSession, draft: QuestionDraft, isFollowUp: boolean): InterviewQuestion {
    const { baseline, maximum } = session.blueprint.difficultyProfile;
    const knownStage = session.blueprint.stages.some((s) => s.name === draft.stage);
    return {
      id: randomUUID(),
      text: spoken(draft.text),
      stage: knownStage ? draft.stage : session.currentStage,
      competency: matchCompetency(draft.competency, session.blueprint.competencyWeights) ?? draft.competency,
      difficulty: Math.min(maximum, Math.max(Math.max(1, baseline - 1), draft.difficulty)),
      source: draft.source,
      sourceEvidence: draft.sourceEvidence,
      expectedEvidence: draft.expectedEvidence,
      followUpTriggers: draft.followUpTriggers,
      maxFollowUps: Math.min(draft.maxFollowUps, 2),
      isFollowUp,
    };
  }

  private addTurn(session: InterviewSession, speaker: TranscriptTurn["speaker"], text: string, questionId?: string) {
    const turn: TranscriptTurn = { id: randomUUID(), speaker, text, questionId, timestamp: this.iso() };
    session.transcript.push(turn);
    return turn;
  }

  private upsertAnswer(session: InterviewSession, questionId: string, text: string): TranscriptTurn {
    const existing = session.transcript.find((t) => t.speaker === "candidate" && t.questionId === questionId);
    if (existing) {
      existing.text = text;
      existing.timestamp = this.iso();
      return existing;
    }
    return this.addTurn(session, "candidate", text, questionId);
  }
}
