import { StrictMode, createElement, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecognitionCallbacks } from "../../hooks/useSpeechRecognition";
import type { AnalyzeResponse, InterviewQuestion, RespondRequest, RespondResponse, StartResponse } from "../../types";

// --- fakes ---------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const speech = {
  calls: [] as { text: string; done: Deferred<"completed" | "cancelled" | "error"> }[],
  cancel: vi.fn(),
};
vi.mock("../tts/useSpeech", () => ({
  useSpeech: () => ({
    speak: (text: string) => {
      const done = deferred<"completed" | "cancelled" | "error">();
      speech.calls.push({ text, done });
      return done.promise;
    },
    cancel: speech.cancel,
    isSpeaking: false,
    needsAudioUnlock: false,
    enableAudio: vi.fn(),
  }),
}));

const mic = {
  callbacks: null as RecognitionCallbacks | null,
  start: vi.fn(),
  abort: vi.fn(),
  /** Words the recognizer delivers while flushing (the end of the sentence). */
  pendingOnFlush: "" as string,
  stopAndFlush: vi.fn(async () => {
    if (mic.pendingOnFlush) mic.callbacks!.onFinal(mic.pendingOnFlush);
    mic.pendingOnFlush = "";
  }),
};
vi.mock("../../hooks/useVoiceInput", () => ({
  useVoiceInput: (cb: RecognitionCallbacks) => {
    mic.callbacks = cb;
    return {
      engine: "web-speech",
      isSupported: true,
      isListening: false,
      modelStatus: "ready",
      start: mic.start,
      stopAndFlush: mic.stopAndFlush,
      abort: mic.abort,
    };
  },
}));

const api = {
  start: vi.fn<(body: unknown) => Promise<StartResponse>>(),
  respond: vi.fn<(body: RespondRequest, signal?: AbortSignal) => Promise<RespondResponse>>(),
};
vi.mock("../../api/interviewApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/interviewApi")>();
  return { ...actual, interviewApi: { start: (b: unknown) => api.start(b), respond: (b: RespondRequest, s?: AbortSignal) => api.respond(b, s) } };
});

const { useConversation, AUTO_FINISH_SILENCE_MS, MAX_ANSWER_DURATION_MS, POST_AI_PAUSE_MS } = await import(
  "./useConversation"
);
const { ApiRequestError } = await import("../../api/interviewApi");

// --- fixtures ------------------------------------------------------------------

const question = (id: string, text: string): InterviewQuestion => ({
  id,
  text,
  stage: "technical_fundamentals",
  competency: "React",
  difficulty: 2,
  source: "job_requirement",
  sourceEvidence: "",
  expectedEvidence: [],
  followUpTriggers: [],
  maxFollowUps: 1,
  isFollowUp: false,
});

const Q1 = question("q1", "How do you manage state?");
const Q2 = question("q2", "How do you test components?");
const progress = {
  currentStage: "technical_fundamentals",
  currentCompetency: "React",
  questionsAsked: 1,
  estimatedQuestionsRemaining: 5,
  competenciesCovered: [],
  elapsedMinutes: 0,
  plannedMinutes: 30,
};

const startResponse: StartResponse = {
  sessionId: "s1",
  turnId: 1,
  persona: { name: "Maya", title: "Interviewer" },
  firstQuestion: Q1,
  openingText: "Hi, I'm Maya.",
  progress,
};

const respondFor = (req: RespondRequest, overrides: Partial<RespondResponse> = {}): RespondResponse => ({
  sessionId: req.sessionId,
  turnId: req.turnId,
  questionId: req.questionId,
  nextTurnId: req.turnId + 1,
  answerSummary: "summary",
  answerEvaluation: {} as RespondResponse["answerEvaluation"],
  nextAction: "move_to_next_competency",
  nextQuestion: Q2,
  shouldContinue: true,
  conversationMessage: `Thanks. ${Q2.text}`,
  progress,
  ...overrides,
});

const analysis = {
  sessionId: "s1",
  jobProfile: {},
  candidateProfile: {},
  interviewBlueprint: {},
} as unknown as AnalyzeResponse;

// --- helpers -------------------------------------------------------------------

const tick = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));

function render(strict = false) {
  const onEnd = vi.fn();
  const avatar = { current: { speak: vi.fn(), stop: vi.fn(), cancel: vi.fn() } };
  const wrapper = strict ? ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children) : undefined;
  const hook = renderHook(() => useConversation({ analysis, avatar, onEnd }), { wrapper });
  return { ...hook, onEnd, avatar };
}

/** Finishes the interviewer's current line (audio `ended`) and waits out the post-speech pause. */
async function finishSpeaking() {
  await act(async () => speech.calls[speech.calls.length - 1].done.resolve("completed"));
  await tick(POST_AI_PAUSE_MS);
}

async function startedAndListening(strict = false) {
  const r = render(strict);
  await tick();
  await finishSpeaking();
  return r;
}

const say = (text: string) => act(() => mic.callbacks!.onFinal(text));

beforeEach(() => {
  vi.useFakeTimers();
  speech.calls = [];
  speech.cancel.mockReset();
  mic.start.mockReset();
  mic.abort.mockReset();
  mic.stopAndFlush.mockClear();
  mic.pendingOnFlush = "";
  api.start.mockReset().mockResolvedValue(startResponse);
  api.respond.mockReset().mockImplementation(async (req) => respondFor(req));
});
afterEach(() => vi.useRealTimers());

// --- scenarios -------------------------------------------------------------------

describe("useConversation (strict half-duplex)", () => {
  it("1–2, 14: speaks the first question with the mic closed, and opens it only after audio ends", async () => {
    const { result } = render();
    await tick();
    expect(speech.calls).toHaveLength(1);
    expect(speech.calls[0].text).toBe(`Hi, I'm Maya. ${Q1.text}`);
    expect(result.current.state).toBe("ai_speaking");

    // However long the audio takes, the mic stays closed.
    await tick(60_000);
    expect(mic.start).not.toHaveBeenCalled();

    await act(async () => speech.calls[0].done.resolve("completed"));
    expect(mic.start).not.toHaveBeenCalled(); // natural pause first
    await tick(POST_AI_PAUSE_MS);
    expect(mic.start).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("waiting_for_candidate");
  });

  it("ignores candidate speech while the AI is speaking", async () => {
    const { result } = render();
    await tick();
    await say("this is speaker echo");
    act(() => mic.callbacks!.onActivity());
    expect(result.current.state).toBe("ai_speaking");
    expect(result.current.finalTranscript).toBe("");
    expect(api.respond).not.toHaveBeenCalled();
  });

  it("3–4: a long answer with pauses shorter than the fallback is never submitted early", async () => {
    const { result } = await startedAndListening();
    await say("First I lift state to the closest common parent.");
    expect(result.current.state).toBe("candidate_speaking");
    for (const part of ["Then I pass it down as props.", "Hmm, let me think.", "For complex logic I use useReducer."]) {
      await tick(2_000); // thinking pause
      await say(part);
    }
    expect(api.respond).not.toHaveBeenCalled();
    expect(result.current.state).toBe("candidate_speaking");
    expect(result.current.finalTranscript).toContain("useReducer");
  });

  it("5, 17, 19: Done speaking locks the full answer to the exact question and sends it once", async () => {
    const { result } = await startedAndListening();
    await say("I keep state close to where it is used");
    mic.pendingOnFlush = "and lift it when needed."; // still in flight when Done is clicked
    await act(async () => result.current.finishAnswer());
    await tick();
    expect(mic.stopAndFlush).toHaveBeenCalledTimes(1);
    expect(api.respond).toHaveBeenCalledTimes(1);
    expect(api.respond.mock.calls[0][0]).toMatchObject({
      sessionId: "s1",
      turnId: 1,
      questionId: Q1.id,
      candidateTranscript: "I keep state close to where it is used and lift it when needed.",
      completionReason: "manual",
    });
  });

  it("6: clicking Done twice submits once", async () => {
    const { result } = await startedAndListening();
    await say("My answer.");
    await act(async () => {
      result.current.finishAnswer();
      result.current.finishAnswer();
    });
    await tick();
    expect(api.respond).toHaveBeenCalledTimes(1);
  });

  it("8: duplicate final results from the browser are not repeated", async () => {
    const { result } = await startedAndListening();
    await say("I wrote unit tests with Jest");
    await say("I wrote unit tests with Jest");
    await say("tests with Jest and React Testing Library");
    expect(result.current.finalTranscript).toBe("I wrote unit tests with Jest and React Testing Library");
  });

  it("silence fallback submits after the configured silence, and resuming cancels it", async () => {
    const { result } = await startedAndListening();
    await say("Part one.");
    await tick(AUTO_FINISH_SILENCE_MS - 100);
    await say("Part two."); // resumed in time
    await tick(AUTO_FINISH_SILENCE_MS - 100);
    expect(api.respond).not.toHaveBeenCalled();
    await tick(200);
    expect(api.respond).toHaveBeenCalledTimes(1);
    expect(api.respond.mock.calls[0][0]).toMatchObject({ candidateTranscript: "Part one. Part two.", completionReason: "silence" });
    expect(result.current.state).toBe("ai_speaking"); // the (instant) response is being spoken
  });

  it("20: the candidate can speak for the full answer duration, then it is submitted", async () => {
    const { result } = await startedAndListening();
    const steps = Math.floor((MAX_ANSWER_DURATION_MS - 1_000) / 2_000);
    for (let i = 0; i < steps; i++) {
      await say(`point ${i}`);
      await tick(2_000);
    }
    expect(api.respond).not.toHaveBeenCalled();
    expect(result.current.state).toBe("candidate_speaking");
    await say("final point"); // just under the cap, still talking
    await tick(2_400); // crosses the cap before the silence fallback
    expect(api.respond).toHaveBeenCalledTimes(1);
    expect(api.respond.mock.calls[0][0].completionReason).toBe("timeout");
  });

  it("an empty capture keeps the turn open instead of submitting", async () => {
    const { result } = await startedAndListening();
    act(() => mic.callbacks!.onActivity()); // noise, no words
    await tick(AUTO_FINISH_SILENCE_MS);
    expect(api.respond).not.toHaveBeenCalled();
    expect(result.current.state).toBe("candidate_speaking");
    expect(result.current.notice).toMatch(/couldn't hear/);
  });

  it("9, 18: while Gemini works the mic stays closed; then the AI speaks exactly once and the next turn opens", async () => {
    const pending = deferred<RespondResponse>();
    api.respond.mockImplementationOnce(() => pending.promise);
    const { result } = await startedAndListening();
    mic.start.mockClear();
    await say("Answer one.");
    await act(async () => result.current.finishAnswer());
    await tick(10_000); // slow Gemini
    expect(result.current.state).toBe("processing_answer");
    expect(mic.start).not.toHaveBeenCalled();
    expect(speech.calls).toHaveLength(1);

    await act(async () => pending.resolve(respondFor(api.respond.mock.calls[0][0])));
    expect(speech.calls).toHaveLength(2);
    expect(speech.calls[1].text).toBe(`Thanks. ${Q2.text}`);
    expect(result.current.state).toBe("ai_speaking");
    expect(result.current.question?.id).toBe(Q2.id);

    await finishSpeaking();
    expect(result.current.state).toBe("waiting_for_candidate");
    expect(result.current.turnId).toBe(2);
    await say("Answer two.");
    await act(async () => result.current.finishAnswer());
    await tick();
    expect(api.respond.mock.calls[1][0]).toMatchObject({ turnId: 2, questionId: Q2.id, candidateTranscript: "Answer two." });
  });

  it("10–11: a failed request keeps the locked answer; Retry resends the same turn without re-recording", async () => {
    api.respond.mockRejectedValueOnce(
      new ApiRequestError("GEMINI_INVALID_OUTPUT", "The interviewer returned malformed output.", true)
    );
    const { result } = await startedAndListening();
    mic.start.mockClear();
    await say("My only answer.");
    await act(async () => result.current.finishAnswer());
    await tick();
    expect(result.current.state).toBe("error");
    expect(result.current.error).toMatchObject({ kind: "respond", canRetry: true });
    expect(result.current.error!.message).toMatch(/Your answer was saved/);
    expect(result.current.lockedAnswer).toBe("My only answer.");
    expect(mic.start).not.toHaveBeenCalled();
    expect(speech.calls).toHaveLength(1);

    await act(async () => result.current.retry());
    await tick();
    expect(api.respond).toHaveBeenCalledTimes(2);
    expect(api.respond.mock.calls[1][0]).toEqual(api.respond.mock.calls[0][0]);
    expect(result.current.state).toBe("ai_speaking");
  });

  it("12: a response for a different turn/question is never applied", async () => {
    api.respond.mockImplementationOnce(async (req) => respondFor(req, { turnId: 7, questionId: "old" }));
    const { result } = await startedAndListening();
    await say("Answer.");
    await act(async () => result.current.finishAnswer());
    await tick();
    expect(speech.calls).toHaveLength(1);
    expect(result.current.question?.id).toBe(Q1.id);
    expect(result.current.state).toBe("error");
  });

  it("13: ending while Gemini is processing aborts it and ignores the late response", async () => {
    const pending = deferred<RespondResponse>();
    api.respond.mockImplementationOnce(() => pending.promise);
    const { result, onEnd } = await startedAndListening();
    await say("Answer in flight.");
    await act(async () => result.current.finishAnswer());
    await tick();
    const signal = api.respond.mock.calls[0][1]!;

    act(() => result.current.endInterview());
    expect(signal.aborted).toBe(true);
    expect(onEnd).toHaveBeenCalledTimes(1);
    const transcript = onEnd.mock.calls[0][1];
    expect(transcript.find((t: { speaker: string }) => t.speaker === "candidate")).toMatchObject({
      questionId: Q1.id,
      text: "Answer in flight.",
    });

    await act(async () => pending.resolve(respondFor(api.respond.mock.calls[0][0])));
    expect(speech.calls).toHaveLength(1);
    expect(result.current.state).toBe("finished");
  });

  it("15: if the voice fails, the mic stays closed until a retry succeeds or text mode is chosen", async () => {
    const { result } = render();
    await tick();
    await act(async () => speech.calls[0].done.resolve("error"));
    await tick(5_000);
    expect(result.current.state).toBe("error");
    expect(result.current.error?.kind).toBe("speech");
    expect(mic.start).not.toHaveBeenCalled();

    await act(async () => result.current.retry());
    expect(speech.calls).toHaveLength(2);
    expect(speech.calls[1].text).toBe(speech.calls[0].text);
    await act(async () => speech.calls[1].done.resolve("error"));

    act(() => result.current.continueWithoutVoice());
    expect(result.current.state).toBe("waiting_for_candidate");
    expect(mic.start).not.toHaveBeenCalled(); // text mode
    act(() => result.current.submitTypedAnswer("Typed answer."));
    await tick();
    expect(api.respond.mock.calls[0][0]).toMatchObject({ candidateTranscript: "Typed answer.", completionReason: "typed" });
  });

  it("16: under React Strict Mode there is one start request and one speech", async () => {
    await startedAndListening(true);
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(speech.calls).toHaveLength(1);
    expect(mic.start).toHaveBeenCalledTimes(1);
  });

  it("speaks the closing line once and then finishes", async () => {
    api.respond.mockImplementationOnce(async (req) =>
      respondFor(req, { shouldContinue: false, nextQuestion: undefined, nextTurnId: null, conversationMessage: "Thanks, that's all." })
    );
    const { result, onEnd } = await startedAndListening();
    await say("Last answer.");
    await act(async () => result.current.finishAnswer());
    await tick();
    expect(speech.calls[speech.calls.length - 1].text).toBe("Thanks, that's all.");
    expect(onEnd).not.toHaveBeenCalled();
    await act(async () => speech.calls[speech.calls.length - 1].done.resolve("completed"));
    expect(result.current.state).toBe("finished");
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});
