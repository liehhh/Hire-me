import { z } from "zod";

// Zod schemas for everything Gemini returns. Model output is never trusted:
// structure and enums are strict (a bad shape fails validation and is
// retried), while numeric ranges and list lengths are clamped rather than
// rejected so a slightly over-long list doesn't cost another request.
//
// The same schemas are converted to JSON Schema and sent as
// `responseJsonSchema`, so Gemini is constrained to the shape up front.

const clamp = (min: number, max: number) => (n: number) =>
  Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;

const text = (max: number) => z.string().transform((s) => s.trim().slice(0, max));
const list = (maxItems: number, maxLen = 400) =>
  z
    .array(z.string())
    .transform((a) => a.map((s) => s.trim().slice(0, maxLen)).filter(Boolean).slice(0, maxItems));
const score05 = z.number().describe("0 (absent) to 5 (excellent)").transform(clamp(0, 5));
const unit = z.number().describe("0..1").transform(clamp(0, 1));
const difficulty = z
  .number()
  .describe("1 (fundamentals) to 5 (expert)")
  .transform((n) => Math.round(clamp(1, 5)(n)) as 1 | 2 | 3 | 4 | 5);

export const STAGE_NAMES = [
  "introduction",
  "resume_walkthrough",
  "role_motivation",
  "technical_fundamentals",
  "technical_deep_dive",
  "coding",
  "system_design",
  "behavioral",
  "situational",
  "domain_specific",
  "candidate_questions",
  "closing",
] as const;

const JOB_FAMILIES = [
  "frontend",
  "backend",
  "fullstack",
  "mobile",
  "data",
  "devops",
  "qa",
  "security",
  "product",
  "design",
  "finance",
  "marketing",
  "sales",
  "operations",
  "other",
] as const;

const SENIORITIES = ["intern", "junior", "mid", "senior", "lead", "principal", "unknown"] as const;
const IMPORTANCE = ["critical", "high", "medium", "low"] as const;
const DEPTHS = ["awareness", "working", "independent", "advanced", "expert", "unknown"] as const;
const EVIDENCE_STATUS = ["explicitly_stated", "partially_supported", "unclear", "not_present"] as const;
const USAGE_CONTEXT = ["listed_only", "project", "professional", "at_scale"] as const;
const QUESTION_SOURCES = [
  "job_requirement",
  "resume_claim",
  "project",
  "previous_answer",
  "general_role_expectation",
] as const;
export const NEXT_ACTIONS = [
  "ask_follow_up",
  "move_to_next_competency",
  "increase_difficulty",
  "decrease_difficulty",
  "clarify_claim",
  "finish_stage",
] as const;
const RECOMMENDATIONS = ["strong_yes", "yes", "mixed", "no", "insufficient_evidence"] as const;
const COMPETENCY_STATUS = ["strong", "partial", "weak", "insufficient_evidence"] as const;

// --- Job analysis -----------------------------------------------------------

export const skillRequirementSchema = z.object({
  name: text(80),
  category: text(60),
  importance: z.enum(IMPORTANCE),
  evidenceInJobDescription: text(300).describe("Quote or close paraphrase from the job description"),
  expectedDepth: z.enum(DEPTHS),
});

export const stageSchema = z.object({
  name: z.enum(STAGE_NAMES),
  purpose: text(240),
  estimatedMinutes: z.number().transform(clamp(1, 45)),
  questionCount: z.number().transform((n) => Math.round(clamp(0, 12)(n))),
  competencies: list(8, 80),
  required: z.boolean(),
});

export const jobAnalysisOutputSchema = z.object({
  normalizedTitle: text(120),
  jobFamily: z.enum(JOB_FAMILIES),
  seniority: z.enum(SENIORITIES),
  coreResponsibilities: list(12),
  requiredSkills: z.array(skillRequirementSchema).transform((a) => a.slice(0, 16)),
  preferredSkills: z.array(skillRequirementSchema).transform((a) => a.slice(0, 12)),
  toolsAndTechnologies: list(30, 60),
  businessContext: list(8),
  likelyCompetencies: list(10, 80),
  likelyInterviewStages: z.array(stageSchema).transform((a) => a.slice(0, 10)),
  estimatedInterviewDurationMinutes: z.number().transform(clamp(10, 120)),
  confidence: unit,
  uncertainties: list(10),
});

// --- Candidate analysis -------------------------------------------------------

export const candidateAnalysisOutputSchema = z.object({
  claimedSkills: list(40, 60),
  skillEvidence: z
    .array(
      z.object({
        skill: text(60),
        usageContext: z.enum(USAGE_CONTEXT),
        evidenceStatus: z.enum(EVIDENCE_STATUS),
        cvEvidence: text(240),
      })
    )
    .transform((a) => a.slice(0, 30)),
  claimedExperience: z
    .array(
      z.object({
        role: text(100),
        organization: text(100),
        duration: text(60),
        summary: text(300),
        technologies: list(15, 60),
        evidenceStatus: z.enum(EVIDENCE_STATUS),
      })
    )
    .transform((a) => a.slice(0, 10)),
  projects: z
    .array(
      z.object({
        name: text(100),
        description: text(300),
        technologies: list(15, 60),
        candidateRole: text(160),
        evidenceStatus: z.enum(EVIDENCE_STATUS),
      })
    )
    .transform((a) => a.slice(0, 10)),
  measurableAchievements: list(12),
  industries: list(8, 60),
  senioritySignals: list(10),
  unclearClaims: list(10),
  missingEvidenceForJobRequirements: list(12),
});

// --- Blueprint ---------------------------------------------------------------

export const blueprintOutputSchema = z.object({
  totalQuestions: z.number().transform((n) => Math.round(clamp(3, 40)(n))),
  estimatedDurationMinutes: z.number().transform(clamp(10, 120)),
  stages: z.array(stageSchema).min(1).transform((a) => a.slice(0, 10)),
  competencyWeights: z
    .array(
      z.object({
        competency: text(80),
        weight: z.number().transform(clamp(0, 100)),
        critical: z.boolean(),
      })
    )
    .min(1)
    .transform((a) => a.slice(0, 12)),
  difficultyProfile: z.object({
    baseline: difficulty,
    maximum: difficulty,
    escalationRules: list(6),
  }),
  requiredCoverage: z
    .array(
      z.object({
        competency: text(80),
        minQuestions: z.number().transform((n) => Math.round(clamp(1, 6)(n))),
        mandatory: z.boolean(),
        reason: text(240),
      })
    )
    .transform((a) => a.slice(0, 12)),
});

// --- Questions + live turns ----------------------------------------------------

export const questionDraftSchema = z.object({
  text: text(500).refine((s) => s.length >= 5, "question text is empty"),
  stage: z.enum(STAGE_NAMES),
  competency: text(80),
  difficulty,
  source: z.enum(QUESTION_SOURCES),
  sourceEvidence: text(300).describe("The requirement, CV claim or prior answer this question tests"),
  expectedEvidence: list(6, 200),
  followUpTriggers: list(5, 200),
  maxFollowUps: z.number().transform((n) => Math.round(clamp(0, 3)(n))),
  isFollowUp: z.boolean(),
});

export const firstQuestionOutputSchema = z.object({
  openingText: text(400).describe("1-2 spoken sentences: greeting and brief agenda, no question"),
  question: questionDraftSchema,
});

export const answerEvaluationSchema = z.object({
  relevance: score05,
  specificity: score05,
  technicalAccuracy: score05.nullable().describe("null if the question had no technical content"),
  ownership: score05,
  depth: score05,
  structure: score05,
  outcomeEvidence: score05,
  confidence: unit,
  supportedClaims: list(6, 300),
  unsupportedClaims: list(6, 300),
  missingDetails: list(6, 300),
  contradictions: list(4, 300),
  evidenceSummary: text(500),
});

/**
 * The next question as written in the (fast) reply call. The long-form
 * metadata (what a strong answer shows, follow-up triggers) is produced
 * afterwards by the evaluation call, so the candidate never waits for it.
 */
export const replyQuestionSchema = questionDraftSchema.pick({
  text: true,
  stage: true,
  competency: true,
  difficulty: true,
  source: true,
  maxFollowUps: true,
  isFollowUp: true,
});

/** Everything the interviewer says next. Kept small: the candidate waits for this call. */
export const liveTurnReplySchema = z.object({
  answerSummary: text(300).describe("One neutral sentence summarising what the candidate said in <candidate_answer>"),
  nextAction: z.enum(NEXT_ACTIONS),
  endInterview: z.boolean(),
  acknowledgement: text(300).describe(
    "Short spoken reaction that refers to something specific the candidate just said; empty string if none"
  ),
  nextQuestion: replyQuestionSchema.nullable(),
  closingMessage: text(400).nullable().describe("Spoken goodbye, only when ending the interview"),
});

/** Background call after the reply: scores the answer and fills in the next question's metadata. */
export const liveTurnEvalSchema = z.object({
  competencyAssessed: text(80).describe("Which blueprint competency this answer gave evidence for"),
  evaluation: answerEvaluationSchema,
  nextQuestionDetails: z
    .object({
      sourceEvidence: text(300).describe("The requirement, CV claim or prior answer the next question tests"),
      expectedEvidence: list(6, 200),
      followUpTriggers: list(5, 200),
    })
    .nullable()
    .describe("null when there is no next question"),
});

// --- Final report ---------------------------------------------------------------

const findingSchema = z.object({
  statement: text(400),
  evidence: text(500).describe("Exact quote or faithful paraphrase from the transcript"),
  impactOnRole: text(300),
  confidence: unit,
});

export const reportOutputSchema = z.object({
  summary: text(900),
  recommendation: z.enum(RECOMMENDATIONS),
  confidence: unit,
  competencyScores: z
    .array(
      z.object({
        competency: text(80),
        score: z.number().transform(clamp(0, 10)).nullable(),
        evidenceStatus: z.enum(COMPETENCY_STATUS),
        supportingQuotes: list(4, 400),
        concerns: list(4, 300),
      })
    )
    .transform((a) => a.slice(0, 14)),
  strengths: z.array(findingSchema).transform((a) => a.slice(0, 6)),
  weaknesses: z.array(findingSchema).transform((a) => a.slice(0, 6)),
  answerCritiques: z
    .array(
      z.object({
        questionId: text(60),
        score: z.number().transform(clamp(0, 10)).nullable(),
        whatWorked: list(4, 300),
        whatWasMissing: list(4, 300),
        factualOrTechnicalConcerns: list(4, 300),
        betterStructure: list(5, 300),
      })
    )
    .transform((a) => a.slice(0, 40)),
  missingEvidence: list(10, 300),
  cvVerificationNotes: list(10, 300),
  recommendedPractice: list(8, 300),
  improvedAnswers: z
    .array(
      z.object({
        questionId: text(60),
        factsStatedByCandidate: list(6, 300),
        suggestedStructure: list(6, 300),
        missingDetails: list(6, 300),
        exampleAnswer: text(1500),
      })
    )
    .transform((a) => a.slice(0, 5)),
});

export type JobAnalysisOutput = z.output<typeof jobAnalysisOutputSchema>;
export type CandidateAnalysisOutput = z.output<typeof candidateAnalysisOutputSchema>;
export type BlueprintOutput = z.output<typeof blueprintOutputSchema>;
export type QuestionDraft = z.output<typeof questionDraftSchema>;
export type FirstQuestionOutput = z.output<typeof firstQuestionOutputSchema>;
export type LiveTurnReply = z.output<typeof liveTurnReplySchema>;
export type LiveTurnEval = z.output<typeof liveTurnEvalSchema>;
export type ReportOutput = z.output<typeof reportOutputSchema>;

// --- Zod -> Gemini JSON Schema -------------------------------------------------

// Keys Gemini's `responseJsonSchema` understands (per the SDK docs).
const SUPPORTED_KEYS = new Set([
  "type",
  "format",
  "title",
  "description",
  "enum",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "anyOf",
  "oneOf",
  "properties",
  "additionalProperties",
  "required",
  "propertyOrdering",
]);

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (!node || typeof node !== "object") return node;

  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (key === "const") {
      out.enum = [value];
    } else if (key === "properties" && value && typeof value === "object") {
      const props: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(value)) props[name] = sanitize(sub);
      out.properties = props;
      // Every field is required in model output; optional-ness is expressed
      // as nullable so the model never silently drops a field.
      out.required = Object.keys(props);
      out.propertyOrdering = Object.keys(props);
    } else if (key === "required" || key === "propertyOrdering") {
      // regenerated above
    } else if (SUPPORTED_KEYS.has(key)) {
      out[key] = sanitize(value);
    }
  }
  return out;
}

export function toGeminiSchema(schema: z.ZodType): Record<string, unknown> {
  return sanitize(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" })) as Record<
    string,
    unknown
  >;
}
