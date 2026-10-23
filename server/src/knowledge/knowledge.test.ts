import { describe, expect, it } from "vitest";
import { jobOutput } from "../interview/testFixtures.js";
import { bankEntry, loadBank, retrieveEntries, sourceOf } from "./questionBank.js";
import { scoreRubric, type RubricSnapshot } from "./rubric.js";

const base = { competencies: ["JavaScript fundamentals"], priorityCompetencies: [] as string[], excludeIds: [] as string[] };

describe("retrieveEntries", () => {
  it("offers entries for the technologies the job names, best match first", () => {
    const hits = retrieveEntries({ ...base, job: jobOutput() });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(3);
    expect(hits.every((h) => h.entry.domain === "javascript" || h.entry.domain === "nodejs")).toBe(true);
    const scores = hits.map((h) => h.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("never offers an entry that was already asked", () => {
    const first = retrieveEntries({ ...base, job: jobOutput() });
    const next = retrieveEntries({ ...base, job: jobOutput(), excludeIds: first.map((h) => h.entry.id) });
    expect(next.some((h) => first.some((f) => f.entry.id === h.entry.id))).toBe(false);
  });

  it("ranks an entry for a priority competency higher", () => {
    const plain = retrieveEntries({ ...base, job: jobOutput(), k: 20 });
    const boosted = retrieveEntries({ ...base, job: jobOutput(), priorityCompetencies: ["Closures"], k: 20 });
    const rank = (hits: typeof plain) => hits.findIndex((h) => h.entry.competency === "Closures");
    expect(rank(boosted)).toBeGreaterThanOrEqual(0);
    expect(rank(boosted)).toBeLessThanOrEqual(rank(plain));
  });

  it("offers nothing for a job the bank does not cover", () => {
    const nurse = jobOutput({
      normalizedTitle: "Registered Nurse",
      jobFamily: "other",
      coreResponsibilities: ["Care for patients"],
      requiredSkills: [],
      toolsAndTechnologies: ["Patient charts"],
    });
    expect(retrieveEntries({ ...base, job: nurse })).toEqual([]);
  });
});

describe("loadBank", () => {
  it("skips invalid and duplicate entries instead of failing", () => {
    const good = bankEntry("js-01")!;
    const bank = loadBank({ entries: [good, { id: "broken" }, good] });
    expect(bank.map((e) => e.id)).toEqual(["js-01"]);
    expect(loadBank({ nope: true })).toEqual([]);
  });

  it("loads the shipped bank with an answer key for every question", () => {
    for (const id of ["js-01", "pg-02", "ai-06"]) {
      const entry = bankEntry(id)!;
      expect(entry.criteria.length).toBeGreaterThan(0);
      expect(entry.question).not.toBe("");
      expect(sourceOf(entry)).toMatchObject({ id, version: 1 });
    }
  });
});

describe("scoreRubric", () => {
  const snapshot: RubricSnapshot = {
    sources: [sourceOf(bankEntry("js-01")!)],
    competency: "Event loop",
    question: "What does this print?",
    expectedAnswerSummary: "A, D, B, C",
    criteria: [1, 2, 3].map((n) => ({ id: `js-01-c${n}`, description: `criterion ${n}`, maxPoints: 1 })),
    commonMisconceptions: [],
  };
  const c = (n: number) => `js-01-c${n}`;
  const score = (criterionId: string, points: number | null, evidence = "said so") => ({
    criterionId,
    points,
    evidence,
    reason: "",
  });

  it("computes the question score and coverage from the criteria in code", () => {
    const r = scoreRubric(snapshot, [score(c(1), 1), score(c(2), 0.5), score(c(3), 0)]);
    expect(r.questionScore).toBe(50);
    expect(r.coverage).toBe(1);
  });

  it("leaves unassessed criteria out of the score and lowers coverage", () => {
    const r = scoreRubric(snapshot, [score(c(1), 1), score(c(2), null)]); // c3 never reported
    expect(r.questionScore).toBe(100);
    expect(r.coverage).toBe(0.33);
    expect(r.criteria.find((x) => x.criterionId === c(3))?.points).toBeNull();
  });

  it("returns a null score when nothing was assessed", () => {
    expect(scoreRubric(snapshot, null)).toMatchObject({ questionScore: null, coverage: 0 });
  });

  it("snaps points to 0, 0.5 or 1, ignores unknown criteria, and drops scores with no evidence", () => {
    const r = scoreRubric(snapshot, [
      score(c(1), 0.8), // snaps to 1
      score(c(2), 7), // clamps to 1
      { criterionId: c(3), points: 1, evidence: "", reason: "" }, // a guess: not assessed
      score("made-up-id", 1),
    ]);
    expect(r.criteria.map((x) => x.points)).toEqual([1, 1, null]);
    expect(r.criteria).toHaveLength(3);
    expect(r.questionScore).toBe(100);
    expect(r.coverage).toBe(0.67);
  });
});
