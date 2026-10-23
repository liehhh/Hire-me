import { describe, expect, it } from "vitest";
import { AppError } from "../services/gemini/geminiErrors.js";
import { InterviewService } from "./interviewService.js";
import { SessionStore } from "./session.js";
import {
  blueprintOutput,
  fakeGenerate,
  jobOutput,
  liveTurnEvalOutput,
  liveTurnOutput,
  questionDraft,
  reportOutput,
} from "./testFixtures.js";

const JD = "We are hiring a Junior Frontend Engineer with React and strong JavaScript skills to build UI components.";

function setup(responders: Record<string, unknown> = {}) {
  let clock = Date.parse("2026-01-01T10:00:00Z");
  const now = () => clock;
  const fake = fakeGenerate({
    job_analysis: jobOutput(),
    candidate_analysis: {
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
    interview_blueprint: blueprintOutput(),
    first_question: { openingText: "Hi, I'm Maya. This will take about thirty minutes.", question: questionDraft() },
    live_turn: () => liveTurnOutput(),
    live_turn_eval: () => liveTurnEvalOutput(),
    final_report: reportOutput(),
    ...responders,
  });
  const store = new SessionStore(now);
  const service = new InterviewService(fake.generate, store, now);
  return { service, store, calls: fake.calls, advance: (min: number) => (clock += min * 60_000) };
}

const analyzeInput = {
  jobDescription: JD,
  resumeText: undefined,
  targetRole: undefined,
  companyName: undefined,
  interviewMode: "mixed" as const,
  preferredLength: "standard" as const,
};

/** Builds a respond request for an exact turn. */
const answer = (sessionId: string, turnId: number, questionId: string, candidateTranscript: string) => ({
  sessionId,
  turnId,
  questionId,
  candidateTranscript,
  completionReason: "manual" as const,
  elapsedSeconds: 30,
});

async function startedInterview(responders?: Record<string, unknown>) {
  const ctx = setup(responders);
  const analysis = await ctx.service.analyze(analyzeInput);
  const start = await ctx.service.start({ sessionId: analysis.sessionId });
  return { ...ctx, analysis, start, sessionId: analysis.sessionId };
}

describe("InterviewService", () => {
  it("skips CV analysis when no resume is given", async () => {
    const { service, calls } = setup();
    const result = await service.analyze(analyzeInput);
    expect(calls).toEqual(["job_analysis", "interview_blueprint"]);
    expect(result.candidateProfile.hasResume).toBe(false);
  });

  it("de-duplicates identical concurrent analyze and start requests", async () => {
    const { service, calls } = setup();
    const [a, b] = await Promise.all([service.analyze(analyzeInput), service.analyze(analyzeInput)]);
    expect(a.sessionId).toBe(b.sessionId);
    const [s1, s2] = await Promise.all([
      service.start({ sessionId: a.sessionId }),
      service.start({ sessionId: a.sessionId }),
    ]);
    expect(s1.firstQuestion.id).toBe(s2.firstQuestion.id);
    expect(calls.filter((c) => c === "first_question")).toHaveLength(1);
  });

  it("rejects text that is not a job description", async () => {
    const { service } = setup({
      job_analysis: jobOutput({ confidence: 0.05, requiredSkills: [], coreResponsibilities: [] }),
    });
    await expect(service.analyze(analyzeInput)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("returns a spoken message combining acknowledgement and the next question, tagged with the turn", async () => {
    const { service, store, sessionId, start } = await startedInterview();
    expect(start.turnId).toBe(1);
    const res = await service.respond(
      answer(sessionId, 1, start.firstQuestion.id, "State is owned by the component, props come from the parent.")
    );
    expect(res).toMatchObject({ sessionId, turnId: 1, questionId: start.firstQuestion.id, nextTurnId: 2 });
    expect(res.shouldContinue).toBe(true);
    expect(res.conversationMessage).toBe(`Thanks. ${res.nextQuestion!.text}`);
    expect(res.progress.questionsAsked).toBe(2);
    expect(res.answerEvaluation).toBeNull();
    // Scoring is a separate call, made after the reply.
    await service.evaluate({ sessionId, questionId: start.firstQuestion.id });
    expect(store.get(sessionId).competenciesCovered).toContain("React fundamentals");
  });

  it("returns the committed response for a duplicate submission without calling Gemini again", async () => {
    const { service, sessionId, start, calls } = await startedInterview();
    const a = await service.respond(answer(sessionId, 1, start.firstQuestion.id, "An answer."));
    // Same key — even with different text (e.g. a late recognition event) — replays the committed turn.
    const b = await service.respond(answer(sessionId, 1, start.firstQuestion.id, "An answer. Plus more"));
    expect(b).toBe(a);
    expect(calls.filter((c) => c === "live_turn")).toHaveLength(1);
  });

  it("runs only one Gemini request for concurrent duplicate submissions", async () => {
    const { service, sessionId, start, calls } = await startedInterview();
    const req = answer(sessionId, 1, start.firstQuestion.id, "Double clicked.");
    const [a, b] = await Promise.all([service.respond(req), service.respond(req)]);
    expect(b).toBe(a);
    expect(calls.filter((c) => c === "live_turn")).toHaveLength(1);
  });

  it("rejects answers for a turn that is not current, and empty answers", async () => {
    const { service, sessionId, start } = await startedInterview();
    // A future/unknown turn, or the right turn with the wrong question.
    await expect(service.respond(answer(sessionId, 2, start.firstQuestion.id, "x"))).rejects.toMatchObject({
      code: "STALE_QUESTION",
    });
    await expect(service.respond(answer(sessionId, 1, "other-question", "x"))).rejects.toMatchObject({
      code: "STALE_QUESTION",
    });
    await expect(service.respond(answer(sessionId, 1, start.firstQuestion.id, ""))).rejects.toMatchObject({
      code: "EMPTY_ANSWER",
    });
    const r1 = await service.respond(answer(sessionId, 1, start.firstQuestion.id, "First."));
    // The answer to turn 2 must use turn 2's question.
    await expect(service.respond(answer(sessionId, 2, start.firstQuestion.id, "x"))).rejects.toMatchObject({
      code: "STALE_QUESTION",
    });
    const r2 = await service.respond(answer(sessionId, 2, r1.nextQuestion!.id, "Second."));
    expect(r2.turnId).toBe(2);
  });

  it("replies without scoring the answer; /evaluate scores it and fills in the next question's metadata", async () => {
    const { service, store, calls, sessionId, start } = await startedInterview();
    const r1 = await service.respond(answer(sessionId, 1, start.firstQuestion.id, "First answer."));
    expect(r1.answerEvaluation).toBeNull();
    expect(r1.nextQuestion).toBeDefined();
    expect(calls).not.toContain("live_turn_eval");
    const session = store.get(sessionId);
    expect(session.evaluations).toHaveLength(0);
    expect(session.currentQuestion!.expectedEvidence).toEqual([]);

    const done = await service.evaluate({ sessionId, questionId: start.firstQuestion.id });
    expect(done.evaluated).toBe(true);
    expect(session.evaluations).toHaveLength(1);
    expect(session.evaluations[0].questionId).toBe(start.firstQuestion.id);
    expect(session.currentQuestion!.expectedEvidence).toEqual(["Explains lexical scope"]);
    expect(session.questions[1].followUpTriggers).toEqual(["No example given"]);

    // A repeat is a no-op, not a second Gemini call.
    expect((await service.evaluate({ sessionId, questionId: start.firstQuestion.id })).evaluated).toBe(false);
    expect(calls.filter((c) => c === "live_turn_eval")).toHaveLength(1);
  });

  describe("reference material and rubrics", () => {
    interface Ref {
      id: string;
      criteria: { id: string }[];
    }
    /** The reference entries Gemini was shown, read from the prompt like the model would. */
    const refsIn = (req: { prompt: string }): Ref[] => {
      const found = /<reference_material>\s*([\s\S]*?)\s*<\/reference_material>/.exec(req.prompt);
      return found ? (JSON.parse(found[1]) as Ref[]) : [];
    };
    const rubricCriterionIds = (req: { prompt: string }): string[] => {
      const found = /<rubric>\s*([\s\S]*?)\s*<\/rubric>/.exec(req.prompt);
      return found ? (JSON.parse(found[1]) as { criteria: { id: string }[] }).criteria.map((c) => c.id) : [];
    };
    const rubric = (referenceIds: string[], overrides: Record<string, unknown> = {}) => ({
      referenceIds,
      codeSnippet: null,
      expectedAnswerSummary: "UNIQUE-ANSWER-KEY microtasks run before timers.",
      criteria: [
        { description: "UNIQUE-CRITERION explains microtasks before timers", adaptedFrom: "js-01-c3" },
        { description: "Gives the reason in their own words", adaptedFrom: null },
      ],
      commonMisconceptions: [],
      ...overrides,
    });

    it("keeps the question Gemini wrote, saves a grounded rubric for it, and scores the answer against it", async () => {
      const ownText = "In your own words, how are a promise callback and a timer callback ordered?";
      const { service, store, sessionId, start } = await startedInterview({
        first_question: (req: { prompt: string }) => ({
          openingText: "Hi, I'm Maya.",
          question: questionDraft({ text: ownText, rubric: rubric([refsIn(req)[0].id]) }),
        }),
        live_turn_eval: (req: { prompt: string }) =>
          liveTurnEvalOutput({
            criterionScores: rubricCriterionIds(req).map((criterionId, i) => ({
              criterionId,
              points: i === 0 ? 1 : 0.5,
              evidence: "Candidate said so.",
              reason: "",
            })),
          }),
      });
      expect(start.firstQuestion.text).toBe(ownText); // never replaced with the bank's wording
      const session = store.get(sessionId);
      const saved = session.rubrics?.[start.firstQuestion.id];
      expect(saved?.question).toBe(ownText);
      expect(saved?.sources).toHaveLength(1);
      expect(saved?.criteria.map((c) => c.id)).toEqual([`${start.firstQuestion.id}-c1`, `${start.firstQuestion.id}-c2`]);
      // The answer key never goes to the browser.
      expect(JSON.stringify(start)).not.toContain("UNIQUE-ANSWER-KEY");
      expect(JSON.stringify(start)).not.toContain("UNIQUE-CRITERION");

      await service.respond(answer(sessionId, 1, start.firstQuestion.id, "An answer."));
      await service.evaluate({ sessionId, questionId: start.firstQuestion.id });
      expect(session.evaluations[0].rubric).toMatchObject({ questionScore: 75, coverage: 1 });
    });

    it("drops a rubric that is not grounded in the reference material it was given", async () => {
      const { store, sessionId, start } = await startedInterview({
        first_question: { openingText: "Hi.", question: questionDraft({ rubric: rubric(["pg-01"]) }) },
      });
      expect(store.get(sessionId).rubrics?.[start.firstQuestion.id]).toBeUndefined();
    });

    it("keeps the exact code of a code question, markdown characters included", async () => {
      const code = "console.log(2 * 3); setTimeout(() => console.log('t'), 0);";
      const text = `What does this print, and in what order? ${code} Explain why.`;
      const { service, store, sessionId, start } = await startedInterview({
        first_question: (req: { prompt: string }) => ({
          openingText: "Hi.",
          question: questionDraft({ text, rubric: rubric([refsIn(req)[0].id], { codeSnippet: code }) }),
        }),
        live_turn: (req: { prompt: string }) =>
          liveTurnOutput({
            nextQuestion: questionDraft({ text: `Now this one: ${code} What happens?`, rubric: rubric([refsIn(req)[0].id], { codeSnippet: code }) }),
          }),
      });
      expect(start.firstQuestion.text).toContain(code); // "*" survives the spoken-text cleanup
      expect(store.get(sessionId).rubrics?.[start.firstQuestion.id]?.codeSnippet).toBe(code);
      const next = await service.respond(answer(sessionId, 1, start.firstQuestion.id, "An answer."));
      expect(next.conversationMessage).toContain(code);
    });

    it("drops the rubric when the question does not contain the code it was derived from", async () => {
      const { store, sessionId, start } = await startedInterview({
        first_question: (req: { prompt: string }) => ({
          openingText: "Hi.",
          question: questionDraft({
            text: "What does the snippet we discussed print?",
            rubric: rubric([refsIn(req)[0].id], { codeSnippet: "console.log(1 + 1);" }),
          }),
        }),
      });
      expect(store.get(sessionId).rubrics?.[start.firstQuestion.id]).toBeUndefined();
    });

    it("grounds a follow-up in the same reference, and stops offering an entry once it was asked", async () => {
      let askedId = "";
      const offered: string[][] = [];
      const { service, sessionId, start } = await startedInterview({
        first_question: (req: { prompt: string }) => {
          askedId = refsIn(req)[0].id;
          return { openingText: "Hi.", question: questionDraft({ rubric: rubric([askedId]) }) };
        },
        live_turn: (req: { prompt: string }) => {
          offered.push(refsIn(req).map((r) => r.id));
          return liveTurnOutput();
        },
      });
      const r1 = await service.respond(answer(sessionId, 1, start.firstQuestion.id, "First."));
      await service.respond(answer(sessionId, 2, r1.nextQuestion!.id, "Second."));
      expect(offered[0]).toContain(askedId); // still available to ground a follow-up on that question
      expect(offered[1]).not.toContain(askedId); // the next question has moved on
    });
  });

  it("finishes with a report even when an answer was never scored", async () => {
    const { service, sessionId, start } = await startedInterview();
    await service.respond(answer(sessionId, 1, start.firstQuestion.id, "First answer."));
    const report = await service.finish({ sessionId, transcript: [] });
    expect(report).toBeDefined();
  });

  it("stores the answer under its question and never commits a turn the interview ended during", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { service, store, sessionId, start } = await startedInterview({
      live_turn: async () => {
        await gate;
        return liveTurnOutput();
      },
    });
    const pending = service.respond(answer(sessionId, 1, start.firstQuestion.id, "Slow answer"));
    const settled = pending.catch((e: unknown) => e);
    await Promise.resolve();
    const session = store.get(sessionId);
    expect(session.transcript.find((t) => t.speaker === "candidate")).toMatchObject({
      questionId: start.firstQuestion.id,
      text: "Slow answer",
    });
    const finishing = service.finish({ sessionId, transcript: [] });
    release();
    expect(await settled).toBeInstanceOf(Error);
    await finishing;
    expect(session.questions).toHaveLength(1);
    expect(session.turnId).toBe(1);
  });

  it("keeps the answer when Gemini fails, and an explicit retry of the same turn succeeds", async () => {
    let fail = true;
    const { service, store, sessionId, start } = await startedInterview({
      live_turn: () => (fail ? new AppError("RATE_LIMITED", "limited", 429, true, 30) : liveTurnOutput()),
    });
    const input = answer(sessionId, 1, start.firstQuestion.id, "My saved answer.");
    await expect(service.respond(input)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    const session = store.get(sessionId);
    expect(session.transcript.at(-1)).toMatchObject({ speaker: "candidate", text: "My saved answer." });
    expect(session.currentQuestion!.id).toBe(start.firstQuestion.id);
    expect(session.turnId).toBe(1);

    fail = false;
    const res = await service.respond(input);
    expect(res.shouldContinue).toBe(true);
    expect(session.transcript.filter((t) => t.speaker === "candidate")).toHaveLength(1);
  });

  it("does not let the model end the interview early", async () => {
    const { service, sessionId, start } = await startedInterview({
      live_turn: () =>
        liveTurnOutput({ endInterview: true, nextQuestion: null, closingMessage: "Bye!" }),
    });
    // mayEnd is false on the first answer, so a missing question is rejected (and retried in production).
    await expect(
      service.respond(answer(sessionId, 1, start.firstQuestion.id, "Answer"))
    ).rejects.toThrow(/no next question/);
  });

  it("forces the interview to end at the hard time cap", async () => {
    const { service, sessionId, start, advance } = await startedInterview({
      live_turn: () => liveTurnOutput({ closingMessage: "That's all, thank you!" }),
    });
    advance(42); // past the 41-minute hard cap (30 planned × 1.35), within the idle TTL
    const res = await service.respond(answer(sessionId, 1, start.firstQuestion.id, "Answer"));
    expect(res.shouldContinue).toBe(false);
    expect(res.nextQuestion).toBeUndefined();
    expect(res.conversationMessage).toBe("That's all, thank you!");
  });

  it("caps follow-ups per question", async () => {
    const followUp = () =>
      liveTurnOutput({
        nextAction: "ask_follow_up",
        nextQuestion: questionDraft({ text: `Follow-up ${Math.random()} what was your part?`, isFollowUp: true }),
      });
    const { service, sessionId, start } = await startedInterview({ live_turn: followUp });
    // First question allows 1 follow-up.
    const r1 = await service.respond(answer(sessionId, 1, start.firstQuestion.id, "We built it."));
    expect(r1.nextQuestion!.isFollowUp).toBe(true);
    const r2 = await service.respond(answer(sessionId, 2, r1.nextQuestion!.id, "I helped."));
    expect(r2.nextQuestion!.isFollowUp).toBe(false);
    expect(r2.nextAction).toBe("move_to_next_competency");
  });

  it("generates the report once, and only regenerates after a failure on explicit retry", async () => {
    let reportFails = true;
    const { service, sessionId, start, calls } = await startedInterview({
      final_report: () => (reportFails ? new AppError("GEMINI_TIMEOUT", "timeout", 504, true) : reportOutput()),
    });
    await service.respond(answer(sessionId, 1, start.firstQuestion.id, "Props flow down."));

    await expect(service.finish({ sessionId, transcript: [] })).rejects.toMatchObject({ code: "GEMINI_TIMEOUT" });
    await expect(service.finish({ sessionId, transcript: [] })).rejects.toMatchObject({ code: "GEMINI_TIMEOUT" });
    expect(calls.filter((c) => c === "final_report")).toHaveLength(1);

    reportFails = false;
    const report = await service.finish({ sessionId, transcript: [], retry: true });
    const again = await service.finish({ sessionId, transcript: [], retry: true });
    expect(again).toBe(report);
    expect(calls.filter((c) => c === "final_report")).toHaveLength(2);
  });

  it("includes an unsubmitted final answer from the client transcript", async () => {
    const { service, store, sessionId, start } = await startedInterview();
    await service.finish({
      sessionId,
      transcript: [
        { id: "c1", speaker: "candidate", text: "Half an answer when I hit end", questionId: start.firstQuestion.id, timestamp: "x" },
        { id: "c2", speaker: "candidate", text: "Unknown question", questionId: "nope", timestamp: "x" },
      ],
    });
    const answers = store.get(sessionId).transcript.filter((t) => t.speaker === "candidate");
    expect(answers.map((a) => a.text)).toEqual(["Half an answer when I hit end"]);
  });

  it("returns an insufficient-evidence report without calling Gemini when nothing was answered", async () => {
    const { service, sessionId, calls } = await startedInterview();
    const report = await service.finish({ sessionId, transcript: [] });
    expect(report.recommendation).toBe("insufficient_evidence");
    expect(report.overallScore).toBeNull();
    expect(calls).not.toContain("final_report");
  });

  it("rejects responses after the interview finished", async () => {
    const { service, sessionId, start } = await startedInterview();
    await service.finish({ sessionId, transcript: [] });
    await expect(
      service.respond(answer(sessionId, 1, start.firstQuestion.id, "late"))
    ).rejects.toMatchObject({ code: "SESSION_FINISHED" });
  });
});
