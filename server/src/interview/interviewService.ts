import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";
import type {
  AnalyzeResponse,
  CandidateProfile,
  EvaluateRequest,
  EvaluateResponse,
  FinishRequest,
  InterviewQuestion,
  InterviewReport,
  RespondRequest,
  RespondResponse,
  StartResponse,
  TranscriptTurn,
} from "../../../shared/interviewTypes.js";
import { LIMITS, MAX_SPOKEN_CHARACTERS } from "../config.js";
import { bankEntry, retrieveEntries, sourceOf, type BankEntry } from "../knowledge/questionBank.js";
import { scoreRubric, type RubricResult, type RubricSnapshot } from "../knowledge/rubric.js";
import type { GenerateStructured } from "../services/gemini/geminiClient.js";
import { AppError } from "../services/gemini/geminiErrors.js";
import type { PromptReference } from "../services/gemini/geminiPrompts.js";
import {
  candidateAnalysisPrompt,
  finalReportPrompt,
  firstQuestionPrompt,
  interviewBlueprintPrompt,
  jobAnalysisPrompt,
  liveTurnEvalPrompt,
  liveTurnPrompt,
} from "../services/gemini/geminiPrompts.js";
import {
  blueprintOutputSchema,
  candidateAnalysisOutputSchema,
  firstQuestionOutputSchema,
  jobAnalysisOutputSchema,
  liveTurnEvalSchema,
  liveTurnReplySchema,
  questionDraftSchema,
  replyQuestionSchema,
  reportOutputSchema,
  type LiveTurnEval,
  type LiveTurnReply,
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

/** A drafted question; the metadata fields are absent when it came from the fast reply call. */
type QuestionInput = z.output<typeof replyQuestionSchema> & Partial<z.output<typeof questionDraftSchema>>;

/** What the report sees for one answer: the 0-5 evaluation plus the rubric result, if there is one. */
function reportEvaluation(scored: InterviewSession["evaluations"][number] | undefined): unknown {
  if (!scored) return "not evaluated (interview ended)";
  if (!scored.rubric) return scored.evaluation;
  const { sources, questionScore, coverage, criteria } = scored.rubric;
  return {
    ...scored.evaluation,
    rubric: {
      sources,
      questionScore,
      coverage,
      criteria: criteria.map((c) => ({ id: c.criterionId, points: c.points, of: c.maxPoints, evidence: c.evidence })),
    },
  };
}

const toPromptReference = (entry: BankEntry): PromptReference => ({
  id: entry.id,
  competency: entry.competency,
  level: entry.level,
  question: entry.question,
  expectedAnswerSummary: entry.expected_answer_summary,
  criteria: entry.criteria.map((c) => ({ id: c.id, description: c.description })),
  commonMisconceptions: entry.common_misconceptions,
  followUpQuestions: entry.follow_up_questions,
});

/** A scored answer waiting to be committed to the session. */
export interface EvaluationResult {
  questionId: string;
  /** Rubric score, computed from the model's per-criterion results, when the question came from the bank. */
  rubric?: RubricResult;
  answerTurnId: string;
  /** The question asked after this answer, whose metadata the evaluation fills in. */
  nextQuestionId?: string;
  output: LiveTurnEval;
}

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

/** Joins spoken parts and keeps the result short enough to speak. */
function spoken(...parts: (string | null | undefined)[]): string {
  return joinSpoken(parts, MAX_SPOKEN_CHARACTERS);
}

function joinSpoken(parts: (string | null | undefined)[], limit: number): string {
  const clean = parts.map((p) => (p ?? "").replace(/[*#`]/g, "").trim()).filter(Boolean);
  let text = clean.join(" ");
  // Drop the acknowledgement before ever truncating the question itself.
  if (text.length > limit && clean.length > 1) text = clean.slice(1).join(" ");
  return truncate(text, limit);
}

const CODE_MARK = "\u0001CODE\u0001";

/**
 * Like `spoken`, but the code a question is about is never touched: markdown
 * is stripped and the text is shortened around it, not through it, so the
 * candidate sees exactly the code the rubric was written for.
 */
function spokenKeeping(code: string | undefined, ...parts: (string | null | undefined)[]): string {
  if (!code) return spoken(...parts);
  const marked = parts.map((p) => (p ?? "").split(code).join(CODE_MARK));
  const limit = Math.max(MAX_SPOKEN_CHARACTERS - code.length + CODE_MARK.length, 200);
  return joinSpoken(marked, limit).split(CODE_MARK).join(code);
}

export class InterviewService {
  private readonly analyzeInFlight = new Map<string, Promise<AnalyzeResponse>>();

  constructor(
    private readonly generate: GenerateStructured,
    private readonly store: SessionStore,
    private readonly now: () => number = Date.now
  ) {}

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
    // The CV is read against the job's skills, but the job description itself
    // is enough for that, so both analyses run side by side.
    const candidatePromise: Promise<CandidateProfile> = input.resumeText
      ? this.generate({
          task: "candidate_analysis",
          ...candidateAnalysisPrompt({ resumeText: input.resumeText, jobDescription: input.jobDescription }),
          schema: candidateAnalysisOutputSchema,
          maxOutputTokens: LIMITS.analysisMaxOutputTokens,
          timeoutMs: ANALYSIS_TIMEOUT_MS,
          thinking: "low",
          temperature: 0.1,
        }).then((profile) => ({ hasResume: true as const, ...profile }))
      : Promise.resolve(EMPTY_CANDIDATE);
    // A rejected CV analysis must not surface as unhandled while the job analysis is still running.
    candidatePromise.catch(() => undefined);

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

    const candidate = await candidatePromise;

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

  /**
   * Reference material for the next question: the bank entries that fit the
   * job and are still unasked, plus the entries behind the current question
   * (a follow-up is grounded in the same material). Empty for jobs the bank
   * does not cover.
   */
  private referencesFor(session: InterviewSession, priorityCompetencies: string[], currentQuestionId?: string): BankEntry[] {
    const asked = Object.values(session.rubrics ?? {}).flatMap((r) => r.sources.map((src) => src.id));
    const retrieved = retrieveEntries({
      job: session.jobProfile,
      competencies: session.blueprint.competencyWeights.map((c) => c.competency),
      priorityCompetencies,
      excludeIds: asked,
    }).map((r) => r.entry);
    const current = (currentQuestionId ? session.rubrics?.[currentQuestionId]?.sources ?? [] : [])
      .map((src) => bankEntry(src.id))
      .filter((e): e is BankEntry => e !== undefined);
    return [...current, ...retrieved.filter((e) => !current.some((c) => c.id === e.id))];
  }

  /**
   * Saves the answer key Gemini wrote for the question it is about to ask.
   * It is only kept when it is grounded in reference material that was
   * actually provided, and, for a code question, when the question contains
   * the exact code the key was derived from. Otherwise the question is asked
   * without a rubric and is scored on the general 0-5 dimensions only.
   */
  private saveRubric(session: InterviewSession, question: InterviewQuestion, draft: QuestionInput, provided: BankEntry[]) {
    const rubric = draft.rubric;
    if (!rubric) return;
    const sources = provided.filter((e) => rubric.referenceIds.includes(e.id));
    if (sources.length === 0 || rubric.criteria.length === 0) {
      console.warn("[interview] dropping a rubric that is not grounded in the reference material provided");
      return;
    }
    const code = rubric.codeSnippet || undefined;
    if (code && !question.text.includes(code)) {
      console.warn("[interview] dropping a rubric whose code is not in the question text");
      return;
    }
    const snapshot: RubricSnapshot = {
      sources: sources.map(sourceOf),
      competency: question.competency,
      question: question.text,
      codeSnippet: code,
      expectedAnswerSummary: rubric.expectedAnswerSummary,
      // Criterion ids are ours, not the model's, so scores can only refer to criteria that exist.
      criteria: rubric.criteria.map((c, i) => ({ id: `${question.id}-c${i + 1}`, description: c.description, maxPoints: 1 })),
      commonMisconceptions: rubric.commonMisconceptions,
    };
    (session.rubrics ??= {})[question.id] = snapshot;
  }

  private async runStart(session: InterviewSession): Promise<StartResponse> {
    chargeGeminiCall(session);
    const references = this.referencesFor(session, session.blueprint.competencyWeights.filter((c) => c.critical).map((c) => c.competency));
    const out = await this.generate({
      task: "first_question",
      ...firstQuestionPrompt({
        job: session.jobProfile,
        candidate: session.candidateProfile,
        blueprint: session.blueprint,
        persona: session.persona,
        references: references.map(toPromptReference),
      }),
      schema: firstQuestionOutputSchema,
      maxOutputTokens: LIMITS.liveTurnMaxOutputTokens,
      temperature: 0.7,
    });

    const question = this.toQuestion(session, out.question, false);
    this.saveRubric(session, question, out.question, references);
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
    const now = this.now();
    const question = session.currentQuestion!;
    const pace = pacing(session, now, question.competency);
    const actions = allowedActions(session);
    chargeGeminiCall(session);

    const stage = session.blueprint.stages.find((s) => s.name === session.currentStage);
    const stageIndex = session.blueprint.stages.findIndex((s) => s.name === session.currentStage);
    const previousQuestions = session.questions.map((q) => q.text);

    const references = this.referencesFor(session, pace.uncovered, question.id);
    const currentRubric = session.rubrics?.[question.id];

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

    // Only the spoken reply is generated here. Scoring the answer is a separate
    // call (`evaluate`) the client fires after this response, so the candidate
    // never waits for it.
    const out: LiveTurnReply = await this.generate({
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
        references: references.map(toPromptReference),
        currentReference: currentRubric && {
          expectedAnswerSummary: currentRubric.expectedAnswerSummary,
          commonMisconceptions: currentRubric.commonMisconceptions,
        },
      }),
      schema: liveTurnReplySchema,
      maxOutputTokens: LIMITS.liveReplyMaxOutputTokens,
      temperature: 0.5,
      signal,
      check: checkReply,
    });

    // The interview ended while Gemini was working — never commit a stale turn.
    const turnId = session.turnId;
    if (signal.aborted || session.status !== "active" || session.currentQuestion?.id !== question.id) {
      throw new AppError("CANCELLED", "The interview ended before this answer was processed.", 409);
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
      this.saveRubric(session, nextQuestion, out.nextQuestion!, references);
      session.followUpsUsed = isFollowUp ? session.followUpsUsed + 1 : 0;
      session.currentQuestion = nextQuestion;
      session.currentStage = nextQuestion.stage;
      session.questions.push(nextQuestion);
      session.questionCount++;
      conversationMessage = spokenKeeping(session.rubrics?.[nextQuestion.id]?.codeSnippet, out.acknowledgement, nextQuestion.text);
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
      answerEvaluation: null,
      nextAction,
      nextQuestion,
      shouldContinue: !ending,
      conversationMessage,
      progress: progressOf(session, this.now()),
    };
    return response;
  }

  // -------------------------------------------------------------------------
  // POST /api/interview/evaluate
  // -------------------------------------------------------------------------

  /** Scores one answered question in an in-memory session (local server). */
  async evaluate(input: EvaluateRequest): Promise<EvaluateResponse> {
    const session = this.store.get(input.sessionId);
    const result = await this.runEvaluation(session, input.questionId);
    if (result) this.applyEvaluation(session, result);
    return { sessionId: input.sessionId, questionId: input.questionId, evaluated: Boolean(result) };
  }

  /**
   * Asks Gemini to score the answer to `questionId`. Reads the session but
   * never changes it, so a serverless handler can run this without holding the
   * session and commit the result afterwards. Returns undefined when there is
   * nothing to do.
   */
  async runEvaluation(session: InterviewSession, questionId: string): Promise<EvaluationResult | undefined> {
    if (session.report || session.evaluations.some((e) => e.questionId === questionId)) return undefined;
    const index = session.questions.findIndex((q) => q.id === questionId);
    const answerIndex = session.transcript.findIndex((t) => t.speaker === "candidate" && t.questionId === questionId);
    if (index < 0 || answerIndex < 0) {
      throw new AppError("STALE_QUESTION", "There is no answer to evaluate for that question.", 409);
    }
    // Scoring is best-effort; it must not eat the budget kept for the report.
    if (session.geminiCalls >= LIMITS.maxGeminiCallsPerSession - 2) return undefined;

    const question = session.questions[index];
    const answerTurn = session.transcript[answerIndex];
    const next = session.questions[index + 1];
    const rubric = session.rubrics?.[questionId];
    const output = await this.generate({
      task: "live_turn_eval",
      ...liveTurnEvalPrompt({
        job: session.jobProfile,
        candidate: session.candidateProfile,
        persona: session.persona,
        competencies: session.blueprint.competencyWeights.map((c) => c.competency),
        question,
        answer: answerTurn.text,
        recentTurns: session.transcript
          .slice(Math.max(0, answerIndex - 4), answerIndex)
          .map((t) => ({ speaker: t.speaker, text: truncate(t.text, 600) })),
        nextQuestionText: next?.text ?? null,
        rubric,
      }),
      schema: liveTurnEvalSchema,
      maxOutputTokens: LIMITS.liveTurnMaxOutputTokens,
      temperature: 0.2,
      thinking: "low",
    });
    return {
      questionId,
      answerTurnId: answerTurn.id,
      nextQuestionId: next?.id,
      output,
      rubric: rubric && scoreRubric(rubric, output.criterionScores),
    };
  }

  /** Commits a finished evaluation. Idempotent per question, so a save retry can re-apply it to a fresh copy. */
  applyEvaluation(session: InterviewSession, result: EvaluationResult) {
    if (session.evaluations.some((e) => e.questionId === result.questionId)) return;
    session.geminiCalls++;
    const { output } = result;
    const competency = resolveCompetency(session, output.competencyAssessed);
    session.evaluations.push({
      questionId: result.questionId,
      competency,
      answerTurnId: result.answerTurnId,
      evaluation: output.evaluation,
      rubric: result.rubric,
    });
    updateLedger(session, competency, output.evaluation, result.answerTurnId);
    if (output.evaluation.relevance >= 2 && !session.competenciesCovered.includes(competency)) {
      session.competenciesCovered.push(competency);
    }

    const details = output.nextQuestionDetails;
    if (details && result.nextQuestionId) {
      // `currentQuestion` is a separate copy of the question once a session has been stored and reloaded.
      for (const q of [session.questions.find((x) => x.id === result.nextQuestionId), session.currentQuestion]) {
        if (q && q.id === result.nextQuestionId) Object.assign(q, details);
      }
    }
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
      evaluation: reportEvaluation(session.evaluations.find((e) => e.questionId === a.questionId)),
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

  private toQuestion(session: InterviewSession, draft: QuestionInput, isFollowUp: boolean): InterviewQuestion {
    const { baseline, maximum } = session.blueprint.difficultyProfile;
    const knownStage = session.blueprint.stages.some((s) => s.name === draft.stage);
    return {
      id: randomUUID(),
      text: spokenKeeping(draft.rubric?.codeSnippet || undefined, draft.text),
      stage: knownStage ? draft.stage : session.currentStage,
      competency: matchCompetency(draft.competency, session.blueprint.competencyWeights) ?? draft.competency,
      difficulty: Math.min(maximum, Math.max(Math.max(1, baseline - 1), draft.difficulty)),
      source: draft.source,
      // Questions from the fast reply call get these filled in later by the evaluation call.
      sourceEvidence: draft.sourceEvidence ?? "",
      expectedEvidence: draft.expectedEvidence ?? [],
      followUpTriggers: draft.followUpTriggers ?? [],
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
