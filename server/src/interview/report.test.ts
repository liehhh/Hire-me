import { describe, expect, it } from "vitest";
import { normalizeBlueprint } from "./blueprint.js";
import { buildValidatedReport, weightedOverallScore, type AnsweredQuestion } from "./report.js";
import type { InterviewSession } from "./session.js";
import { blueprintOutput, jobOutput, reportOutput } from "./testFixtures.js";
import { isFaithfulQuote } from "./text.js";

const START = Date.parse("2026-01-01T10:00:00Z");

function session(overrides: Partial<InterviewSession> = {}): InterviewSession {
  const job = jobOutput();
  return {
    sessionId: "s1",
    status: "finished",
    jobProfile: job,
    candidateProfile: {
      hasResume: true,
      claimedSkills: ["React"],
      skillEvidence: [],
      claimedExperience: [],
      projects: [],
      measurableAchievements: [],
      industries: [],
      senioritySignals: [],
      unclearClaims: [],
      missingEvidenceForJobRequirements: [],
    },
    blueprint: normalizeBlueprint(blueprintOutput(), job, "standard"),
    interviewMode: "mixed",
    resumeText: "Built a dashboard in React used by 200 customers.",
    persona: { name: "Maya", title: "Interviewer" },
    transcript: [],
    questions: [],
    evaluations: [],
    ledger: [],
    currentStage: "closing",
    turnId: 1,
    responses: new Map(),
    followUpsUsed: 0,
    questionCount: 2,
    competenciesCovered: [],
    createdAt: new Date(START).toISOString(),
    startedAt: new Date(START).toISOString(),
    lastActivityAt: new Date(START).toISOString(),
    endedEarlyByCandidate: false,
    geminiCalls: 5,
    ...overrides,
  };
}

const evaluation = (relevance: number) => ({
  relevance,
  specificity: 3,
  technicalAccuracy: 3,
  ownership: 3,
  depth: 3,
  structure: 3,
  outcomeEvidence: 3,
  confidence: 0.8,
  supportedClaims: [],
  unsupportedClaims: [],
  missingDetails: [],
  contradictions: [],
  evidenceSummary: "",
});

const answered: AnsweredQuestion[] = [
  {
    questionId: "q1",
    question: "How do you manage state?",
    competency: "React fundamentals",
    difficulty: 2,
    answer: "I keep state in the closest common parent and pass it down as props, um, and I use useReducer when the logic gets complex.",
  },
];

describe("weightedOverallScore", () => {
  it("excludes untested competencies from the denominator", () => {
    expect(
      weightedOverallScore([
        { score: 8, weight: 0.5 },
        { score: null, weight: 0.5 },
      ])
    ).toBe(80);
    expect(weightedOverallScore([{ score: null, weight: 1 }])).toBeNull();
  });
});

describe("isFaithfulQuote", () => {
  it("accepts exact and lightly-edited quotes, rejects fabricated ones", () => {
    const corpus = answered[0].answer;
    expect(isFaithfulQuote("I keep state in the closest common parent", corpus)).toBe(true);
    expect(isFaithfulQuote("“I use useReducer when the logic gets complex.”", corpus)).toBe(true);
    expect(isFaithfulQuote("I keep state in the closest common parent … useReducer when the logic gets complex", corpus)).toBe(true);
    expect(isFaithfulQuote("I reduced bundle size by 40% using code splitting", corpus)).toBe(false);
  });
});

describe("buildValidatedReport", () => {
  const s = () =>
    session({
      evaluations: [{ questionId: "q1", competency: "React fundamentals", answerTurnId: "t1", evaluation: evaluation(4) }],
    });

  it("nulls scores without interview evidence and recomputes the overall score", () => {
    const report = buildValidatedReport(
      reportOutput({
        competencyScores: [
          { competency: "React fundamentals", score: 7, evidenceStatus: "partial", supportingQuotes: ["pass it down as props"], concerns: [] },
          // The model scored a competency that was never discussed:
          { competency: "JavaScript fundamentals", score: 9, evidenceStatus: "strong", supportingQuotes: ["I love closures"], concerns: [] },
        ],
      }),
      s(),
      answered,
      START + 30 * 60_000
    );
    const react = report.competencyScores.find((c) => c.competency === "React fundamentals")!;
    const js = report.competencyScores.find((c) => c.competency === "JavaScript fundamentals")!;
    expect(react.score).toBe(7);
    expect(js.score).toBeNull();
    expect(js.evidenceStatus).toBe("insufficient_evidence");
    expect(js.supportingQuotes).toEqual([]);
    expect(report.overallScore).toBe(70);
    // Only one of the critical competencies has evidence -> not enough to recommend.
    expect(report.recommendation).toBe("insufficient_evidence");
    expect(report.missingEvidence.join(" ")).toMatch(/JavaScript fundamentals/);
    expect(report.validationNotes.join(" ")).toMatch(/could not be found/);
  });

  it("drops strengths that mention technologies the candidate never mentioned", () => {
    const report = buildValidatedReport(
      reportOutput({
        strengths: [
          { statement: "Understands state placement in React", evidence: "I keep state in the closest common parent", impactOnRole: "Core skill", confidence: 0.8 },
          { statement: "Experienced with Kubernetes deployments", evidence: "pass it down as props", impactOnRole: "Ops", confidence: 0.6 },
        ],
      }),
      s(),
      answered,
      START + 30 * 60_000
    );
    expect(report.strengths.map((x) => x.statement)).toEqual(["Understands state placement in React"]);
  });

  it("replaces invented metrics and technologies in improved answers with placeholders", () => {
    const report = buildValidatedReport(
      reportOutput({
        improvedAnswers: [
          {
            questionId: "q1",
            factsStatedByCandidate: ["Keeps state in the closest common parent", "Led a team of 12 engineers"],
            suggestedStructure: ["Principle", "Example", "Result"],
            missingDetails: ["A real example"],
            exampleAnswer:
              "I keep state in the closest common parent. On a dashboard used by 200 customers we cut renders by 35% and deployed it on Kubernetes. [insert your actual responsibility]",
          },
        ],
      }),
      s(),
      answered,
      START + 30 * 60_000
    );
    const ia = report.improvedAnswers[0];
    expect(ia.factsStatedByCandidate).toEqual(["Keeps state in the closest common parent"]);
    expect(ia.exampleAnswer).toContain("200 customers"); // stated in the CV
    expect(ia.exampleAnswer).not.toContain("35%");
    expect(ia.exampleAnswer).not.toMatch(/Kubernetes/);
    expect(ia.exampleAnswer).toContain("[insert your actual responsibility]");
    expect(report.answerCritiques[0].answer).toBe(answered[0].answer);
  });

  it("lowers confidence for short interviews", () => {
    const report = buildValidatedReport(reportOutput({ confidence: 0.9 }), s(), answered, START + 5 * 60_000);
    expect(report.confidence).toBeLessThan(0.5);
  });
});

describe("normalizeBlueprint", () => {
  it("clamps a junior plan to a realistic duration and difficulty", () => {
    const bp = normalizeBlueprint(
      blueprintOutput({
        totalQuestions: 40,
        estimatedDurationMinutes: 120,
        difficultyProfile: { baseline: 5, maximum: 5, escalationRules: [] },
      }),
      jobOutput({ seniority: "junior" }),
      "standard"
    );
    expect(bp.estimatedDurationMinutes).toBeLessThanOrEqual(36);
    expect(bp.estimatedDurationMinutes).toBeGreaterThanOrEqual(29);
    expect(bp.totalQuestions).toBeLessThanOrEqual(Math.floor(bp.estimatedDurationMinutes / 1.5));
    expect(bp.difficultyProfile).toMatchObject({ baseline: 2, maximum: 3 });
    expect(bp.competencyWeights.reduce((s, w) => s + w.weight, 0)).toBeCloseTo(1, 2);
    const stageQuestions = bp.stages.filter((x) => x.name !== "closing").reduce((s, x) => s + x.questionCount, 0);
    expect(stageQuestions).toBe(bp.totalQuestions);
    expect(bp.stages.at(-1)!.name).toBe("closing");
  });

  it("gives senior roles a longer, harder plan than junior roles", () => {
    const junior = normalizeBlueprint(blueprintOutput(), jobOutput({ seniority: "junior" }), "standard");
    const senior = normalizeBlueprint(
      blueprintOutput({ estimatedDurationMinutes: 60, difficultyProfile: { baseline: 2, maximum: 2, escalationRules: [] } }),
      jobOutput({ seniority: "senior" }),
      "standard"
    );
    expect(senior.estimatedDurationMinutes).toBeGreaterThan(junior.estimatedDurationMinutes);
    expect(senior.difficultyProfile.baseline).toBeGreaterThanOrEqual(3);
  });

  it("keeps escalation headroom and never plans to end early, even for a weak CV", () => {
    const bp = normalizeBlueprint(
      blueprintOutput({
        difficultyProfile: {
          baseline: 2,
          maximum: 2,
          escalationRules: [
            "If candidate shows zero understanding of programming, terminate early.",
            "If answers depend on the interviewer's hints, simplify the next question.",
          ],
        },
      }),
      jobOutput({ seniority: "mid" }),
      "standard"
    );
    expect(bp.difficultyProfile.maximum).toBe(3);
    expect(bp.difficultyProfile.escalationRules).toEqual([
      "If answers depend on the interviewer's hints, simplify the next question.",
    ]);
  });

  it("marks every critical competency as mandatory coverage", () => {
    const bp = normalizeBlueprint(blueprintOutput({ requiredCoverage: [] }), jobOutput(), "standard");
    expect(bp.requiredCoverage.map((c) => c.competency).sort()).toEqual(
      ["JavaScript fundamentals", "React fundamentals"].sort()
    );
  });
});
