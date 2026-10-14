import type {
  AnswerEvaluation,
  EvidenceLedgerItem,
  InterviewProgress,
  NextAction,
} from "../../../shared/interviewTypes.js";
import { LIMITS } from "../config.js";
import { NEXT_ACTIONS } from "../services/gemini/geminiSchemas.js";
import { matchCompetency, sameCompetency } from "./blueprint.js";
import type { InterviewSession } from "./session.js";

// Deterministic interview pacing. Gemini proposes; these rules decide what
// is allowed: when follow-ups are permitted, when the interview may end and
// when it must end.

export function elapsedMinutes(session: InterviewSession, now: number): number {
  if (!session.startedAt) return 0;
  return Math.max(0, (now - Date.parse(session.startedAt)) / 60_000);
}

/** Answers counting as a real attempt at a competency (not off-topic/empty). */
function attemptsFor(session: InterviewSession, competency: string) {
  return session.evaluations.filter((e) => e.competency === competency && e.evaluation.relevance >= 2);
}

export function criticalCompetencies(session: InterviewSession): { competency: string; minQuestions: number }[] {
  const out = new Map<string, number>();
  for (const w of session.blueprint.competencyWeights) if (w.critical) out.set(w.competency, 1);
  for (const c of session.blueprint.requiredCoverage) {
    if (c.mandatory) out.set(c.competency, Math.max(out.get(c.competency) ?? 1, Math.min(c.minQuestions, 2)));
  }
  return [...out].map(([competency, minQuestions]) => ({ competency, minQuestions }));
}

/** Critical competencies that have not been tested enough yet. */
export function uncoveredCritical(session: InterviewSession, pendingCompetency?: string): string[] {
  return criticalCompetencies(session)
    .filter(({ competency, minQuestions }) => {
      // The answer being evaluated right now is assumed to be an attempt.
      const pending = pendingCompetency === competency ? 1 : 0;
      const asked = session.evaluations.filter((e) => e.competency === competency).length + pending;
      // Two asked-but-irrelevant answers also count as "tested" — we don't
      // keep hammering the same competency forever.
      return attemptsFor(session, competency).length + pending < minQuestions && asked < minQuestions + 1;
    })
    .map((c) => c.competency);
}

export function hardQuestionCap(session: InterviewSession) {
  return Math.min(LIMITS.maxQuestions, Math.ceil(session.blueprint.totalQuestions * 1.3) + 1);
}

export function hardMinuteCap(session: InterviewSession) {
  return Math.min(LIMITS.maxInterviewMinutes, Math.ceil(session.blueprint.estimatedDurationMinutes * 1.35));
}

export function pacing(session: InterviewSession, now: number, pendingCompetency?: string) {
  const elapsed = elapsedMinutes(session, now);
  const planned = session.blueprint.estimatedDurationMinutes;
  const uncovered = uncoveredCritical(session, pendingCompetency);
  // questionCount includes the question currently being answered.
  const mustEnd =
    session.questionCount >= hardQuestionCap(session) ||
    elapsed >= hardMinuteCap(session) ||
    session.geminiCalls >= LIMITS.maxGeminiCallsPerSession - 3;
  const reachedPlan = elapsed >= planned * 0.8 || session.questionCount >= session.blueprint.totalQuestions;
  const mayEnd = mustEnd || (uncovered.length === 0 && reachedPlan);
  return { elapsed, planned, uncovered, mustEnd, mayEnd };
}

export function allowedActions(session: InterviewSession): NextAction[] {
  const q = session.currentQuestion;
  const followUpsLeft = q ? session.followUpsUsed < q.maxFollowUps : false;
  return NEXT_ACTIONS.filter((a) => followUpsLeft || (a !== "ask_follow_up" && a !== "clarify_claim"));
}

export function estimatedQuestionsRemaining(session: InterviewSession, now: number): number {
  const { mustEnd, uncovered } = pacing(session, now);
  if (mustEnd) return 0;
  const byPlan = session.blueprint.totalQuestions - session.questionCount;
  const cap = hardQuestionCap(session) - session.questionCount;
  return Math.max(0, Math.min(cap, Math.max(byPlan, uncovered.length)));
}

export function progressOf(session: InterviewSession, now: number): InterviewProgress {
  return {
    currentStage: session.currentStage,
    currentCompetency: session.currentQuestion?.competency ?? "",
    questionsAsked: session.questionCount,
    estimatedQuestionsRemaining: estimatedQuestionsRemaining(session, now),
    competenciesCovered: session.competenciesCovered,
    elapsedMinutes: Math.round(elapsedMinutes(session, now)),
    plannedMinutes: session.blueprint.estimatedDurationMinutes,
  };
}

export function coverageSummary(session: InterviewSession) {
  return session.blueprint.competencyWeights.map((w) => ({
    competency: w.competency,
    critical: w.critical,
    questionsAsked: session.evaluations.filter((e) => e.competency === w.competency).length,
    evidenceConfidence: session.ledger.find((l) => l.competency === w.competency)?.confidence ?? 0,
  }));
}

/** Resolves which blueprint competency an evaluated answer belongs to. */
export function resolveCompetency(session: InterviewSession, proposed: string): string {
  const weights = session.blueprint.competencyWeights;
  return (
    matchCompetency(proposed, weights) ??
    matchCompetency(session.currentQuestion?.competency ?? "", weights) ??
    session.currentQuestion?.competency ??
    proposed
  );
}

const MAX_LEDGER_ENTRIES = 12;
const pushCapped = (list: string[], items: string[]) => {
  for (const item of items) if (item && !list.includes(item)) list.push(item);
  list.splice(0, Math.max(0, list.length - MAX_LEDGER_ENTRIES));
};

/** Records one evaluated answer into the evidence ledger. */
export function updateLedger(
  session: InterviewSession,
  competency: string,
  evaluation: AnswerEvaluation,
  answerTurnId: string
) {
  let item = session.ledger.find((l) => sameCompetency(l.competency, competency));
  if (!item) {
    item = {
      competency,
      evidenceFor: [],
      evidenceAgainst: [],
      unanswered: [],
      confidence: 0,
      transcriptReferences: [],
    };
    session.ledger.push(item);
  }
  pushCapped(item.evidenceFor, evaluation.supportedClaims);
  pushCapped(item.evidenceAgainst, evaluation.contradictions);
  if (evaluation.technicalAccuracy !== null && evaluation.technicalAccuracy < 2) {
    pushCapped(item.evidenceAgainst, [`Technical concern: ${evaluation.evidenceSummary}`]);
  }
  pushCapped(item.unanswered, [
    ...evaluation.missingDetails,
    ...evaluation.unsupportedClaims.map((c) => `Unsupported: ${c}`),
  ]);
  pushCapped(item.transcriptReferences, [answerTurnId]);
  // Evidence accumulates: each relevant answer closes part of the remaining gap.
  const contribution = evaluation.confidence * (evaluation.relevance / 5);
  item.confidence = Number((1 - (1 - item.confidence) * (1 - contribution * 0.7)).toFixed(2));
}
