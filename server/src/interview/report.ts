import type {
  AnswerCritique,
  CompetencyScore,
  EvidenceBasedFinding,
  ImprovedAnswer,
  InterviewReport,
  Recommendation,
} from "../../../shared/interviewTypes.js";
import type { ReportOutput } from "../services/gemini/geminiSchemas.js";
import { matchCompetency } from "./blueprint.js";
import { criticalCompetencies, elapsedMinutes } from "./flow.js";
import type { InterviewSession } from "./session.js";
import { isFaithfulQuote, mentionsTerm, supportRatio } from "./text.js";

// Validation pass run on every model-written report before it reaches the
// browser. Anything that can't be traced to the transcript is removed or
// downgraded, and the numbers are recomputed here rather than trusted.

export interface AnsweredQuestion {
  questionId: string;
  question: string;
  competency: string;
  difficulty: number;
  answer: string;
}

const RECOMMENDATION_BANDS: [number, Recommendation][] = [
  [80, "strong_yes"],
  [65, "yes"],
  [50, "mixed"],
  [0, "no"],
];
const BAND_ORDER: Recommendation[] = ["no", "mixed", "yes", "strong_yes"];

export function recommendationForScore(score: number): Recommendation {
  return RECOMMENDATION_BANDS.find(([min]) => score >= min)![1];
}

/** Weighted mean over competencies WITH evidence only, scaled to 0..100. */
export function weightedOverallScore(scores: Pick<CompetencyScore, "score" | "weight">[]): number | null {
  const withEvidence = scores.filter((s) => s.score !== null && s.weight > 0);
  const denom = withEvidence.reduce((sum, s) => sum + s.weight, 0);
  if (denom === 0) return null;
  const num = withEvidence.reduce((sum, s) => sum + (s.score as number) * s.weight, 0);
  return Math.round((num / denom) * 10);
}

/** Technology-ish terms known for this interview, used to detect invented ones. */
function knownTerms(session: InterviewSession): string[] {
  const { jobProfile: job, candidateProfile: cv } = session;
  const terms = new Set<string>();
  for (const t of [
    ...job.toolsAndTechnologies,
    ...job.requiredSkills.map((s) => s.name),
    ...job.preferredSkills.map((s) => s.name),
    ...cv.claimedSkills,
  ]) {
    // Only short, specific names — "Communication skills" isn't a technology.
    if (t && t.split(/\s+/).length <= 3) terms.add(t);
  }
  return [...terms];
}

/** Terms mentioned in `text` that the candidate never said and the CV never states. */
function inventedTerms(text: string, terms: string[], evidenceCorpus: string): string[] {
  return terms.filter((t) => mentionsTerm(text, t) && !mentionsTerm(evidenceCorpus, t));
}

const PLACEHOLDER = /\[[^\]]*\]/g;

/** Replaces numbers/metrics in a model answer that the candidate never stated. */
function scrubInventedNumbers(text: string, evidenceCorpus: string): { text: string; count: number } {
  let count = 0;
  const placeholders: string[] = [];
  const masked = text.replace(PLACEHOLDER, (m) => {
    placeholders.push(m);
    return `\u0000${placeholders.length - 1}\u0000`;
  });
  // Standalone numbers only — "S3", "EC2" or "OAuth2" are names, not metrics.
  const NUMBER = /(?<![\p{L}\p{N}.])\d[\d,.]*(?:\s*(?:%|(?:percent|x|k|ms|seconds|minutes|hours|days|users|requests)\b))?(?![\p{L}\p{N}])/giu;
  const scrubbed = masked.replace(NUMBER, (m) => {
    const digits = m.match(/\d[\d,.]*/)![0].replace(/[.,]+$/, "");
    if (evidenceCorpus.includes(digits)) return m;
    count++;
    return `[insert the real metric]${m.match(/[.,]+$/)?.[0] ?? ""}`;
  });
  const restored = scrubbed.replace(/\u0000(\d+)\u0000/g, (_m, i) => placeholders[Number(i)]);
  return { text: restored.replace(/\s+/g, " ").trim(), count };
}

export function buildValidatedReport(
  raw: ReportOutput,
  session: InterviewSession,
  answered: AnsweredQuestion[],
  now: number
): InterviewReport {
  const notes: string[] = [];
  const transcriptCorpus = answered.map((a) => a.answer).join("\n");
  const evidenceCorpus = `${transcriptCorpus}\n${session.resumeText}`;
  const terms = knownTerms(session);
  const weights = session.blueprint.competencyWeights;

  // 1-2. Competency scores: canonical list from the blueprint, quotes must
  // exist in the transcript, no evidence => null.
  let droppedQuotes = 0;
  const competencyScores: CompetencyScore[] = weights.map((w) => {
    const modelEntry = raw.competencyScores.find((c) => matchCompetency(c.competency, [w]) !== undefined);
    const quotes = (modelEntry?.supportingQuotes ?? []).filter((q) => {
      const ok = isFaithfulQuote(q, transcriptCorpus);
      if (!ok) droppedQuotes++;
      return ok;
    });
    const interviewEvidence = session.evaluations.filter(
      (e) => e.competency === w.competency && e.evaluation.relevance >= 2
    ).length;
    const hasEvidence = interviewEvidence > 0 || quotes.length > 0;
    let score = modelEntry?.score ?? null;
    let evidenceStatus = modelEntry?.evidenceStatus ?? "insufficient_evidence";
    if (!hasEvidence || score === null || evidenceStatus === "insufficient_evidence") {
      if (score !== null && !hasEvidence) {
        notes.push(`"${w.competency}" had no interview evidence, so its score was removed.`);
      }
      score = null;
      evidenceStatus = "insufficient_evidence";
    }
    return {
      competency: w.competency,
      score: score === null ? null : Math.round(score * 10) / 10,
      weight: w.weight,
      evidenceStatus,
      supportingQuotes: quotes,
      concerns: modelEntry?.concerns ?? [],
    };
  });
  if (droppedQuotes > 0) {
    notes.push(`${droppedQuotes} quote(s) were removed because they could not be found in the transcript.`);
  }

  // 11. Overall score is computed, never taken from the model.
  const overallScore = weightedOverallScore(competencyScores);

  const totalWeight = weights.reduce((s, w) => s + w.weight, 0) || 1;
  const coveredWeight = competencyScores.filter((c) => c.score !== null).reduce((s, c) => s + c.weight, 0);
  const coverage = coveredWeight / totalWeight;
  const critical = criticalCompetencies(session).map((c) => c.competency);
  const criticalCovered = critical.filter((c) => competencyScores.find((s) => s.competency === c)?.score !== null);
  const criticalMissed = critical.filter((c) => !criticalCovered.includes(c));
  const criticalCoverage = critical.length ? criticalCovered.length / critical.length : 1;

  // Recommendation must agree with the computed score (± one band).
  let recommendation: Recommendation = raw.recommendation;
  if (overallScore === null || coverage < 0.5 || criticalCoverage < 0.5) {
    if (recommendation !== "insufficient_evidence") {
      notes.push("Recommendation set to insufficient evidence: too few competencies were assessed.");
    }
    recommendation = "insufficient_evidence";
  } else if (recommendation !== "insufficient_evidence") {
    const computed = recommendationForScore(overallScore);
    if (Math.abs(BAND_ORDER.indexOf(computed) - BAND_ORDER.indexOf(recommendation)) > 1) {
      notes.push(`Recommendation adjusted to match the weighted score of ${overallScore}.`);
      recommendation = computed;
    }
  }

  // 12. Confidence drops with incomplete evidence or a short interview.
  const durationMinutes = Math.round(elapsedMinutes(session, now));
  const planned = session.blueprint.estimatedDurationMinutes;
  let confidence = Math.min(raw.confidence, 0.3 + 0.65 * coverage);
  if (answered.length < 4) confidence *= 0.7;
  if (durationMinutes < planned * 0.5) {
    confidence *= 0.8;
    notes.push(`The interview ran ${durationMinutes} of ~${planned} planned minutes, so confidence is reduced.`);
  }
  confidence = Math.round(confidence * 100) / 100;

  // 2-3, 9. Findings need specific, transcript-backed evidence; strengths may
  // not mention technologies the candidate never brought up.
  const checkFinding = (f: EvidenceBasedFinding, kind: "strength" | "weakness") => {
    if (f.statement.length < 12 || f.evidence.length < 8) return false;
    if (kind === "strength") {
      const backed = isFaithfulQuote(f.evidence, transcriptCorpus) || supportRatio(f.evidence, transcriptCorpus) >= 0.6;
      if (!backed) return false;
      if (inventedTerms(`${f.statement} ${f.evidence}`, terms, evidenceCorpus).length > 0) return false;
    }
    return true;
  };
  const strengths = raw.strengths.filter((f) => checkFinding(f, "strength"));
  const weaknesses = raw.weaknesses.filter((f) => checkFinding(f, "weakness"));
  const droppedFindings = raw.strengths.length - strengths.length + (raw.weaknesses.length - weaknesses.length);
  if (droppedFindings > 0) {
    notes.push(`${droppedFindings} finding(s) were removed because they were not supported by the transcript.`);
  }

  // 4. Improved answers: only candidate-stated facts; invented numbers and
  // technologies become placeholders.
  let scrubbed = 0;
  const improvedAnswers: ImprovedAnswer[] = [];
  for (const ia of raw.improvedAnswers) {
    const qa = answered.find((a) => a.questionId === ia.questionId);
    if (!qa) continue;
    const corpus = `${qa.answer}\n${session.resumeText}`;
    const facts = ia.factsStatedByCandidate.filter((f) => supportRatio(f, corpus) >= 0.6);
    scrubbed += ia.factsStatedByCandidate.length - facts.length;
    let { text, count } = scrubInventedNumbers(ia.exampleAnswer, corpus);
    scrubbed += count;
    // Technologies named in the question itself are fair to reference.
    for (const term of inventedTerms(text, terms, `${corpus}\n${qa.question}`)) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      text = text.replace(new RegExp(escaped, "gi"), "[insert the real technology]");
      scrubbed++;
    }
    improvedAnswers.push({
      questionId: qa.questionId,
      question: qa.question,
      factsStatedByCandidate: facts,
      suggestedStructure: ia.suggestedStructure,
      missingDetails: ia.missingDetails,
      exampleAnswer: text,
    });
  }
  if (scrubbed > 0) {
    notes.push(`${scrubbed} unsupported detail(s) in suggested answers were replaced with placeholders.`);
  }

  // Critiques: question/answer text always comes from the real transcript.
  const answerCritiques: AnswerCritique[] = answered.map((qa) => {
    const c = raw.answerCritiques.find((x) => x.questionId === qa.questionId);
    return {
      questionId: qa.questionId,
      question: qa.question,
      answer: qa.answer,
      score: c?.score ?? null,
      whatWorked: c?.whatWorked ?? [],
      whatWasMissing: c?.whatWasMissing ?? (c ? [] : ["This answer was not reviewed in detail."]),
      factualOrTechnicalConcerns: c?.factualOrTechnicalConcerns ?? [],
      betterStructure: c?.betterStructure ?? [],
      improvedAnswer: improvedAnswers.find((ia) => ia.questionId === qa.questionId)?.exampleAnswer,
    };
  });

  // 5, 7. Untested competencies are listed as missing evidence, not failures.
  const missingEvidence = [...raw.missingEvidence];
  for (const c of competencyScores.filter((s) => s.score === null)) {
    if (!missingEvidence.some((m) => m.toLowerCase().includes(c.competency.toLowerCase()))) {
      missingEvidence.push(`There was insufficient interview evidence to assess ${c.competency}.`);
    }
  }

  // 6. Difficulty sanity check against the job's seniority.
  if (answered.length > 0) {
    const avg = answered.reduce((s, a) => s + a.difficulty, 0) / answered.length;
    const { baseline, maximum } = session.blueprint.difficultyProfile;
    if (avg > maximum + 0.5 || avg < baseline - 1) {
      notes.push(
        `Average question difficulty (${avg.toFixed(1)}) was outside the planned ${baseline}-${maximum} range for this seniority.`
      );
    }
  }
  if (criticalMissed.length > 0) {
    notes.push(`Critical competencies not assessed: ${criticalMissed.join(", ")}.`);
  }

  return {
    overallScore,
    recommendation,
    confidence,
    summary: raw.summary,
    competencyScores,
    strengths,
    weaknesses,
    answerCritiques,
    missingEvidence,
    cvVerificationNotes: session.candidateProfile.hasResume ? raw.cvVerificationNotes : [],
    recommendedPractice: raw.recommendedPractice,
    improvedAnswers,
    validationNotes: notes,
    interviewStats: {
      questionsAsked: session.questionCount,
      durationMinutes,
      plannedMinutes: planned,
      criticalCompetenciesCovered: criticalCovered,
      criticalCompetenciesMissed: criticalMissed,
    },
  };
}

/** Report for an interview with no answers — no Gemini call needed. */
export function emptyReport(session: InterviewSession, now: number): InterviewReport {
  const raw: ReportOutput = {
    summary: "The interview ended before any answers were given, so there is no evidence to assess.",
    recommendation: "insufficient_evidence",
    confidence: 0,
    competencyScores: [],
    strengths: [],
    weaknesses: [],
    answerCritiques: [],
    missingEvidence: [],
    cvVerificationNotes: [],
    recommendedPractice: [],
    improvedAnswers: [],
  };
  const report = buildValidatedReport(raw, session, [], now);
  report.validationNotes = ["No answers were recorded; no AI report was generated."];
  return report;
}
