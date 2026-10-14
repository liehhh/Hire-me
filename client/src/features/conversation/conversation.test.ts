import { describe, expect, it } from "vitest";
import { canTransition, ConversationMachine } from "./conversationMachine";
import { appendFinalChunk } from "./transcript";

describe("ConversationMachine", () => {
  it("follows the half-duplex cycle", () => {
    const m = new ConversationMachine();
    for (const s of [
      "preparing",
      "ai_speaking",
      "waiting_for_candidate",
      "candidate_speaking",
      "candidate_finished",
      "processing_answer",
      "ready_for_ai",
      "ai_speaking",
      "finished",
    ] as const) {
      expect(m.transition(s)).toBe(true);
    }
  });

  it("rejects overlapping turns", () => {
    // The mic may not open while the AI speaks, and the AI may not speak over the candidate.
    expect(canTransition("ai_speaking", "candidate_speaking")).toBe(false);
    expect(canTransition("candidate_speaking", "ai_speaking")).toBe(false);
    expect(canTransition("waiting_for_candidate", "ai_speaking")).toBe(false);
    // An answer can't be submitted twice, nor processed before it's finished.
    expect(canTransition("processing_answer", "processing_answer")).toBe(false);
    expect(canTransition("candidate_speaking", "processing_answer")).toBe(false);
    // Nothing leaves "finished".
    expect(canTransition("finished", "preparing")).toBe(false);
  });

  it("does not change state or notify on a rejected transition", () => {
    const rejected: string[] = [];
    const m = new ConversationMachine((from, to) => rejected.push(`${from}->${to}`));
    const seen: string[] = [];
    m.subscribe((s) => seen.push(s));
    m.transition("preparing");
    expect(m.transition("candidate_speaking")).toBe(false);
    expect(m.state).toBe("preparing");
    expect(seen).toEqual(["preparing"]);
    expect(rejected).toEqual(["preparing->candidate_speaking"]);
  });

  it("allows recovery from errors only into retryable states", () => {
    expect(canTransition("error", "processing_answer")).toBe(true);
    expect(canTransition("error", "ai_speaking")).toBe(true);
    expect(canTransition("error", "candidate_speaking")).toBe(false);
  });
});

describe("appendFinalChunk", () => {
  it("appends new final text", () => {
    expect(appendFinalChunk("", "I built a dashboard.")).toBe("I built a dashboard.");
    expect(appendFinalChunk("I built a dashboard.", "It used React.")).toBe("I built a dashboard. It used React.");
  });

  it("ignores a duplicated final result", () => {
    const t = "I built a dashboard in React";
    expect(appendFinalChunk(t, "built a dashboard in React")).toBe(t);
    expect(appendFinalChunk(t, "I built a dashboard in React")).toBe(t);
  });

  it("keeps only the new part of an overlapping result", () => {
    expect(appendFinalChunk("I built a dashboard in React", "a dashboard in React with hooks and context")).toBe(
      "I built a dashboard in React with hooks and context"
    );
  });

  it("does not drop short legitimate repeats", () => {
    expect(appendFinalChunk("I think", "I think it worked")).toBe("I think I think it worked");
  });
});
