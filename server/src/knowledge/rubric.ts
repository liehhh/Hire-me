// Rubric snapshots and scoring for questions that came from the question bank.
// The model reports what it saw per criterion; every number the app stores or
// shows is computed here, in code, from those reports.

export interface RubricCriterion {
  id: string;
  description: string;
  maxPoints: number;
}

/** The reference-bank entry (and version) a rubric was grounded in. */
export interface RubricSource {
  id: string;
  version: number;
  reviewStatus: string;
}

/**
 * The rubric written for one asked question, saved before it was asked. It is
 * stored with the session (never sent to the browser), so the answer is
 * always graded against what the candidate was actually asked, and a later
 * edit of the bank cannot change it.
 */
export interface RubricSnapshot {
  /** The reference entries it was grounded in. */
  sources: RubricSource[];
  competency: string;
  /** The question exactly as asked. */
  question: string;
  /** For code-output questions: the exact code the candidate was shown. */
  codeSnippet?: string;
  expectedAnswerSummary: string;
  criteria: RubricCriterion[];
  commonMisconceptions: string[];
}

/** What the model returns for one criterion. */
export interface RawCriterionScore {
  criterionId: string;
  /** Share of the criterion's points the answer earned: 0, 0.5 or 1. Null = not assessed. */
  points: number | null;
  evidence: string;
  reason: string;
}

export interface CriterionResult {
  criterionId: string;
  maxPoints: number;
  /** Points awarded, or null when the criterion was not assessed. */
  points: number | null;
  evidence: string;
  reason: string;
}

export interface RubricResult {
  sources: RubricSource[];
  criteria: CriterionResult[];
  /** 0-100 over the assessed criteria only; null when nothing was assessed. */
  questionScore: number | null;
  /** Assessed maximum points / all maximum points, 0-1. Low coverage means the score is not a full assessment. */
  coverage: number;
}

/** Only 0, 0.5 and 1 are valid; anything else is snapped to the nearest. */
function snapShare(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, Math.round(value * 2) / 2));
}

export function scoreRubric(snapshot: RubricSnapshot, raw: RawCriterionScore[] | null | undefined): RubricResult {
  const byId = new Map((raw ?? []).map((r) => [r.criterionId, r]));
  const criteria: CriterionResult[] = snapshot.criteria.map((c) => {
    const r = byId.get(c.id);
    const evidence = r?.evidence.trim() ?? "";
    const reason = r?.reason.trim() ?? "";
    // A score with no evidence and no reason is a guess; unknown ids never reach this map.
    const assessed = r !== undefined && r.points !== null && (evidence !== "" || reason !== "");
    return {
      criterionId: c.id,
      maxPoints: c.maxPoints,
      points: assessed ? snapShare(r!.points!) * c.maxPoints : null,
      evidence,
      reason,
    };
  });

  const total = criteria.reduce((sum, c) => sum + c.maxPoints, 0);
  const assessed = criteria.filter((c) => c.points !== null);
  const assessedMax = assessed.reduce((sum, c) => sum + c.maxPoints, 0);
  const awarded = assessed.reduce((sum, c) => sum + (c.points ?? 0), 0);

  return {
    sources: snapshot.sources,
    criteria,
    questionScore: assessedMax > 0 ? Math.round((100 * awarded) / assessedMax) : null,
    coverage: total > 0 ? Math.round((assessedMax / total) * 100) / 100 : 0,
  };
}
