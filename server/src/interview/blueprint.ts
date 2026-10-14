import type {
  CompetencyWeight,
  InterviewBlueprint,
  InterviewStage,
  JobProfile,
  PreferredLength,
  Seniority,
} from "../../../shared/interviewTypes.js";
import { LIMITS } from "../config.js";
import { DURATION_GUIDELINES } from "../services/gemini/geminiPrompts.js";
import type { BlueprintOutput } from "../services/gemini/geminiSchemas.js";
import { normalize } from "./text.js";

// The model proposes a blueprint; this module enforces the parts that must
// not be left to the model: realistic duration for the job's seniority,
// hard question caps, normalised weights, and seniority-appropriate
// difficulty.

type Level = 1 | 2 | 3 | 4 | 5;

const DIFFICULTY_BANDS: Record<Seniority, { baseline: [Level, Level]; maxStep: number }> = {
  intern: { baseline: [1, 1], maxStep: 1 },
  junior: { baseline: [1, 2], maxStep: 1 },
  mid: { baseline: [2, 3], maxStep: 1 },
  senior: { baseline: [3, 4], maxStep: 1 },
  lead: { baseline: [4, 4], maxStep: 1 },
  principal: { baseline: [4, 5], maxStep: 1 },
  unknown: { baseline: [2, 3], maxStep: 1 },
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function durationRangeFor(seniority: Seniority) {
  return DURATION_GUIDELINES[seniority === "unknown" ? "mid" : seniority];
}

/** Target window for the preferred length within the seniority range. */
export function targetDuration(seniority: Seniority, length: PreferredLength) {
  const { min, max } = durationRangeFor(seniority);
  const span = max - min;
  const window =
    length === "short"
      ? { lo: min, hi: min + span * 0.4 }
      : length === "deep"
        ? { lo: min + span * 0.6, hi: max }
        : { lo: min + span * 0.25, hi: max - span * 0.25 };
  return {
    lo: Math.round(window.lo),
    hi: Math.round(Math.min(window.hi, LIMITS.maxInterviewMinutes)),
    target: Math.round(Math.min((window.lo + window.hi) / 2, LIMITS.maxInterviewMinutes)),
  };
}

export const sameCompetency = (a: string, b: string) => {
  const na = normalize(a);
  const nb = normalize(b);
  return na === nb || (na.length > 3 && nb.length > 3 && (na.includes(nb) || nb.includes(na)));
};

/** Finds the canonical blueprint competency for a free-text name. */
export function matchCompetency(name: string, weights: CompetencyWeight[]): string | undefined {
  return weights.find((w) => sameCompetency(w.competency, name))?.competency;
}

const STAGE_ORDER_TAIL = ["candidate_questions", "closing"];

export function normalizeBlueprint(
  raw: BlueprintOutput,
  job: JobProfile,
  length: PreferredLength
): InterviewBlueprint {
  // --- duration + question count
  const window = targetDuration(job.seniority, length);
  const estimatedDurationMinutes = Math.round(clamp(raw.estimatedDurationMinutes, window.lo, window.hi));
  const maxQuestions = Math.min(LIMITS.maxQuestions, Math.floor(estimatedDurationMinutes / 1.5));
  const minQuestions = Math.min(maxQuestions, Math.ceil(estimatedDurationMinutes / 4));
  const totalQuestions = clamp(raw.totalQuestions, minQuestions, maxQuestions);

  // --- competency weights: dedupe, normalise to sum 1, ensure ≥1 critical
  const weights: CompetencyWeight[] = [];
  for (const w of raw.competencyWeights) {
    if (!w.competency || weights.some((x) => sameCompetency(x.competency, w.competency))) continue;
    weights.push({ ...w });
  }
  const totalWeight = weights.reduce((s, w) => s + w.weight, 0);
  for (const w of weights) {
    w.weight = Number((totalWeight > 0 ? w.weight / totalWeight : 1 / weights.length).toFixed(3));
  }
  if (!weights.some((w) => w.critical) && weights.length > 0) {
    weights.reduce((top, w) => (w.weight > top.weight ? w : top)).critical = true;
  }

  // --- coverage: only known competencies; every critical one is mandatory
  const requiredCoverage = raw.requiredCoverage
    .map((c) => ({ ...c, competency: matchCompetency(c.competency, weights) ?? "" }))
    .filter((c, i, all) => c.competency && all.findIndex((x) => x.competency === c.competency) === i);
  for (const w of weights.filter((x) => x.critical)) {
    const existing = requiredCoverage.find((c) => c.competency === w.competency);
    if (existing) existing.mandatory = true;
    else
      requiredCoverage.push({
        competency: w.competency,
        minQuestions: 1,
        mandatory: true,
        reason: "Critical requirement for this role.",
      });
  }

  // --- stages: dedupe, keep order with candidate_questions/closing last,
  // and rescale question counts to the total.
  const stages: InterviewStage[] = [];
  for (const s of raw.stages) {
    if (stages.some((x) => x.name === s.name)) continue;
    stages.push({ ...s });
  }
  stages.sort((a, b) => STAGE_ORDER_TAIL.indexOf(a.name) - STAGE_ORDER_TAIL.indexOf(b.name));
  const scored = stages.filter((s) => s.name !== "closing");
  const plannedSum = scored.reduce((s, x) => s + x.questionCount, 0);
  if (plannedSum > 0 && plannedSum !== totalQuestions) {
    const factor = totalQuestions / plannedSum;
    let assigned = 0;
    scored.forEach((s, i) => {
      s.questionCount =
        i === scored.length - 1
          ? Math.max(s.questionCount > 0 ? 1 : 0, totalQuestions - assigned)
          : Math.max(s.questionCount > 0 ? 1 : 0, Math.round(s.questionCount * factor));
      assigned += s.questionCount;
    });
  }
  const minutesSum = stages.reduce((s, x) => s + x.estimatedMinutes, 0) || 1;
  for (const s of stages) {
    s.estimatedMinutes = Math.max(1, Math.round((s.estimatedMinutes / minutesSum) * estimatedDurationMinutes));
  }

  // --- difficulty follows the job's seniority, not the CV
  const band = DIFFICULTY_BANDS[job.seniority];
  const baseline = clamp(raw.difficultyProfile.baseline, band.baseline[0], band.baseline[1]) as Level;
  // Headroom to escalate is always available: a weak CV must not cap the
  // ceiling below what the job's seniority calls for.
  const maximum = Math.min(5, baseline + band.maxStep) as Level;

  return {
    totalQuestions,
    estimatedDurationMinutes,
    stages: stages.filter((s) => s.questionCount > 0 || s.name === "closing"),
    competencyWeights: weights,
    difficultyProfile: {
      baseline,
      maximum,
      escalationRules: raw.difficultyProfile.escalationRules.filter((r) => !/\b(terminate|end|stop)\b.*\b(early|interview)\b/i.test(r)),
    },
    requiredCoverage,
  };
}
