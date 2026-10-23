import type { z } from "zod";
import type { GenerateStructured, StructuredRequest } from "../services/gemini/geminiClient.js";
import type {
  BlueprintOutput,
  JobAnalysisOutput,
  LiveTurnEval,
  LiveTurnReply,
  QuestionDraft,
  ReportOutput,
} from "../services/gemini/geminiSchemas.js";

// Canned, schema-valid model outputs for tests. Each is a plain object run
// through the real Zod schema by the fake generator, exactly as live output is.

export function jobOutput(overrides: Partial<JobAnalysisOutput> = {}): JobAnalysisOutput {
  return {
    normalizedTitle: "Junior Frontend Engineer",
    jobFamily: "frontend",
    seniority: "junior",
    coreResponsibilities: ["Build React components", "Fix UI bugs"],
    requiredSkills: [
      { name: "React", category: "frontend", importance: "critical", evidenceInJobDescription: "React experience", expectedDepth: "working" },
      { name: "JavaScript", category: "language", importance: "critical", evidenceInJobDescription: "Strong JavaScript", expectedDepth: "working" },
    ],
    preferredSkills: [],
    toolsAndTechnologies: ["React", "JavaScript", "Jest", "Kubernetes"],
    businessContext: [],
    likelyCompetencies: ["React fundamentals", "JavaScript fundamentals", "Debugging", "Collaboration"],
    likelyInterviewStages: [],
    estimatedInterviewDurationMinutes: 30,
    confidence: 0.8,
    uncertainties: [],
    ...overrides,
  };
}

export function blueprintOutput(overrides: Partial<BlueprintOutput> = {}): BlueprintOutput {
  return {
    totalQuestions: 10,
    estimatedDurationMinutes: 30,
    stages: [
      { name: "introduction", purpose: "warm up", estimatedMinutes: 3, questionCount: 1, competencies: [], required: true },
      { name: "technical_fundamentals", purpose: "React/JS", estimatedMinutes: 15, questionCount: 6, competencies: ["React fundamentals", "JavaScript fundamentals"], required: true },
      { name: "behavioral", purpose: "teamwork", estimatedMinutes: 8, questionCount: 3, competencies: ["Collaboration"], required: true },
      { name: "closing", purpose: "wrap up", estimatedMinutes: 2, questionCount: 0, competencies: [], required: false },
    ],
    competencyWeights: [
      { competency: "React fundamentals", weight: 40, critical: true },
      { competency: "JavaScript fundamentals", weight: 30, critical: true },
      { competency: "Debugging", weight: 15, critical: false },
      { competency: "Collaboration", weight: 15, critical: false },
    ],
    difficultyProfile: { baseline: 2, maximum: 3, escalationRules: ["Raise after two strong answers"] },
    requiredCoverage: [
      { competency: "React fundamentals", minQuestions: 1, mandatory: true, reason: "critical" },
    ],
    ...overrides,
  };
}

export function questionDraft(overrides: Partial<QuestionDraft> = {}): QuestionDraft {
  return {
    text: "How do you decide what belongs in React state versus props?",
    stage: "technical_fundamentals",
    competency: "React fundamentals",
    difficulty: 2,
    source: "job_requirement",
    sourceEvidence: "React experience",
    expectedEvidence: ["Explains data ownership"],
    followUpTriggers: ["No example given"],
    maxFollowUps: 1,
    isFollowUp: false,
    rubric: null,
    ...overrides,
  };
}

export function liveTurnOutput(overrides: Partial<LiveTurnReply> = {}): LiveTurnReply {
  return {
    answerSummary: "The candidate explained where React state should live.",
    nextAction: "move_to_next_competency",
    endInterview: false,
    acknowledgement: "Thanks.",
    nextQuestion: questionDraft({ text: `Question ${Math.random().toString(36).slice(2)} about closures and scope?`, competency: "JavaScript fundamentals" }),
    closingMessage: null,
    ...overrides,
  };
}

export function liveTurnEvalOutput(overrides: Partial<LiveTurnEval> = {}): LiveTurnEval {
  return {
    competencyAssessed: "React fundamentals",
    criterionScores: null,
    nextQuestionDetails: {
      sourceEvidence: "Closures come up in the job description",
      expectedEvidence: ["Explains lexical scope"],
      followUpTriggers: ["No example given"],
    },
    evaluation: {
      relevance: 4,
      specificity: 3,
      technicalAccuracy: 4,
      ownership: 3,
      depth: 3,
      structure: 3,
      outcomeEvidence: 2,
      confidence: 0.7,
      supportedClaims: ["Explained lifting state up"],
      unsupportedClaims: [],
      missingDetails: ["No concrete example"],
      contradictions: [],
      evidenceSummary: "Reasonable understanding of state ownership.",
    },
    ...overrides,
  };
}

export function reportOutput(overrides: Partial<ReportOutput> = {}): ReportOutput {
  return {
    summary: "Solid fundamentals with gaps in testing.",
    recommendation: "yes",
    confidence: 0.8,
    competencyScores: [],
    strengths: [],
    weaknesses: [],
    answerCritiques: [],
    missingEvidence: [],
    cvVerificationNotes: [],
    recommendedPractice: [],
    improvedAnswers: [],
    ...overrides,
  };
}

type Responder = (req: StructuredRequest<z.ZodType>) => unknown;

/** Fake GenerateStructured: routes by task, validates through the real schema, runs `check`. */
export function fakeGenerate(responders: Record<string, Responder | unknown>) {
  const calls: string[] = [];
  const generate: GenerateStructured = async (req) => {
    calls.push(req.task);
    if (req.signal?.aborted) throw new Error("aborted");
    const responder = responders[req.task];
    if (responder === undefined) throw new Error(`no fake for task ${req.task}`);
    const raw = typeof responder === "function" ? await (responder as Responder)(req) : responder;
    if (raw instanceof Error) throw raw;
    const data = req.schema.parse(raw);
    const problem = req.check?.(data);
    if (problem) throw new Error(`check failed: ${problem}`);
    return data;
  };
  return { generate, calls };
}
