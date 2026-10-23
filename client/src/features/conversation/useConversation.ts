import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ApiRequestError, interviewApi, isCancelled } from "../../api/interviewApi";
import { startInterview } from "../../api/startInterview";
import { useVoiceInput } from "../../hooks/useVoiceInput";
import type { AvatarSpeechAdapter } from "../avatar/AvatarSpeechAdapter";
import { useSpeech } from "../tts/useSpeech";
import type {
  AnalyzeResponse,
  AnswerCompletionReason,
  InterviewProgress,
  InterviewQuestion,
  InterviewerPersona,
  TranscriptTurn,
} from "../../types";
import { ConversationMachine, LISTENING_STATES, type ConversationState } from "./conversationMachine";

/** Recognition text is still accepted while the answer is being flushed and locked. */
const CAPTURE_STATES: ConversationState[] = [...LISTENING_STATES, "candidate_finished"];
import { appendFinalChunk } from "./transcript";

// The single authority over the interview conversation (strict half-duplex):
//
//   AI speaks → audio fully ends → mic opens → candidate speaks freely →
//   candidate finishes → mic closes, answer locked to its turn/question →
//   one backend request → the interviewer speaks one response → repeat.
//
// the voice, speech recognition and the network never change the state on
// their own; they report back here and every move is checked by the
// ConversationMachine. Async results carry the turn/request they belong to
// and are dropped if that turn is no longer current.

/** Natural beat between the interviewer finishing and the mic opening. */
export const POST_AI_PAUSE_MS = 150;
/**
 * Fallback only — "Done speaking" is the primary way to end an answer. Every
 * second of this is dead air before the interviewer reacts, so it is kept
 * short; speech activity restarts it, so a pause to think rarely trips it.
 */
export const AUTO_FINISH_SILENCE_MS = 3_500;
/**
 * Safety net for a mic left running, not a limit on long answers: candidates
 * may talk for as long as they need.
 */
export const MAX_ANSWER_DURATION_MS = 30 * 60_000;

export type ConversationErrorKind = "start" | "respond" | "speech" | "session";

export interface ConversationError {
  kind: ConversationErrorKind;
  message: string;
  canRetry: boolean;
}

interface LockedAnswer {
  turnId: number;
  questionId: string;
  questionText: string;
  transcript: string;
  reason: AnswerCompletionReason;
}

interface PendingSpeech {
  text: string;
  then: "listen" | "finish";
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Codes after which the same request can never succeed. */
const TERMINAL_CODES = new Set([
  "SESSION_NOT_FOUND",
  "SESSION_EXPIRED",
  "SESSION_FINISHED",
  "STALE_QUESTION",
  "SESSION_LIMIT_REACHED",
  "GEMINI_MODEL_UNAVAILABLE",
]);

export function useConversation(options: {
  analysis: AnalyzeResponse;
  avatar: RefObject<AvatarSpeechAdapter | null>;
  onEnd: (sessionId: string, transcript: TranscriptTurn[]) => void;
}) {
  const { analysis } = options;
  const onEndRef = useRef(options.onEnd);
  onEndRef.current = options.onEnd;

  // --- authoritative state (refs for async code, mirrored into React state) --
  const machineRef = useRef<ConversationMachine | null>(null);
  if (!machineRef.current) {
    machineRef.current = new ConversationMachine((from, to) => {
      if (process.env.NODE_ENV !== "production") console.debug(`[conversation] rejected transition ${from} → ${to}`);
    });
  }
  const machine = machineRef.current;
  const [state, setState] = useState<ConversationState>(machine.state);
  useEffect(() => machine.subscribe(setState), [machine]);

  const sessionIdRef = useRef(analysis.sessionId);
  const turnIdRef = useRef(0);
  const questionRef = useRef<InterviewQuestion | null>(null);
  const finalTranscriptRef = useRef("");
  const interimTranscriptRef = useRef("");
  const isSubmittingAnswerRef = useRef(false);
  const lockedAnswerRef = useRef<LockedAnswer | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);
  const requestAbortRef = useRef<AbortController | null>(null);
  const pendingSpeechRef = useRef<PendingSpeech | null>(null);
  const speechTokenRef = useRef(0);
  const transcriptRef = useRef<TranscriptTurn[]>([]);
  const startedRef = useRef(false);
  const mountedRef = useRef(true);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxAnswerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const answerStartedAtRef = useRef<number | null>(null);
  const callStartedAtRef = useRef(Date.now());

  // --- display state ---------------------------------------------------------
  const [persona, setPersona] = useState<InterviewerPersona | null>(null);
  const [question, setQuestion] = useState<InterviewQuestion | null>(null);
  const [turnId, setTurnId] = useState(0);
  const [progress, setProgress] = useState<InterviewProgress | null>(null);
  const [interviewerLine, setInterviewerLine] = useState("");
  const [finalTranscript, setFinalTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [lockedAnswer, setLockedAnswer] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [error, setError] = useState<ConversationError | null>(null);
  const [answerStartedAt, setAnswerStartedAt] = useState<number | null>(null);

  const tts = useSpeech({ avatar: options.avatar });


  // --- timers ------------------------------------------------------------------
  const clearSilenceTimer = () => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = null;
  };
  const clearTimers = () => {
    clearSilenceTimer();
    if (maxAnswerTimerRef.current) clearTimeout(maxAnswerTimerRef.current);
    maxAnswerTimerRef.current = null;
  };

  const resetCandidateTranscript = () => {
    finalTranscriptRef.current = "";
    interimTranscriptRef.current = "";
    setFinalTranscript("");
    setInterimTranscript("");
  };

  const record = (speaker: TranscriptTurn["speaker"], text: string, questionId?: string) => {
    if (speaker === "candidate" && questionId) {
      const existing = transcriptRef.current.find((t) => t.speaker === "candidate" && t.questionId === questionId);
      if (existing) {
        existing.text = text;
        return;
      }
    }
    transcriptRef.current.push({ id: newId(), speaker, text, questionId, timestamp: new Date().toISOString() });
  };

  // Late-bound so recognition callbacks always reach the current closures.
  const finishAnswerRef = useRef<(reason: AnswerCompletionReason) => void>(() => undefined);

  // --- candidate speech (only used while the candidate has the floor) -------
  const voice = useVoiceInput({
    onFinal: (chunk) => {
      if (!machine.is(...CAPTURE_STATES)) return;
      finalTranscriptRef.current = appendFinalChunk(finalTranscriptRef.current, chunk);
      setFinalTranscript(finalTranscriptRef.current);
      onCandidateActivity();
    },
    onInterim: (text) => {
      if (!machine.is(...CAPTURE_STATES)) return;
      interimTranscriptRef.current = text;
      setInterimTranscript(text);
    },
    onActivity: () => {
      if (machine.is(...LISTENING_STATES)) onCandidateActivity();
    },
    onFatalError: (message) => {
      // The turn stays open so the candidate can type instead.
      setMicError(message);
    },
  });

  function onCandidateActivity() {
    if (machine.state === "waiting_for_candidate") {
      if (!machine.transition("candidate_speaking")) return;
      const startedAt = Date.now();
      answerStartedAtRef.current = startedAt;
      setAnswerStartedAt(startedAt);
      setNotice(null);
      maxAnswerTimerRef.current = setTimeout(() => finishAnswerRef.current("timeout"), MAX_ANSWER_DURATION_MS);
    }
    if (machine.state !== "candidate_speaking") return;
    // Any sign of speech cancels a pending auto-finish.
    clearSilenceTimer();
    silenceTimerRef.current = setTimeout(() => finishAnswerRef.current("silence"), AUTO_FINISH_SILENCE_MS);
  }

  // --- ending ------------------------------------------------------------------
  const complete = () => {
    clearTimers();
    speechTokenRef.current++;
    activeRequestIdRef.current = null;
    requestAbortRef.current?.abort();
    tts.cancel();
    voice.abort();
    // An answer that was given but never evaluated still belongs in the report.
    const q = questionRef.current;
    const unsent = lockedAnswerRef.current?.transcript ?? finalTranscriptRef.current.trim();
    if (unsent && q) record("candidate", unsent, q.id);
    onEndRef.current(sessionIdRef.current, transcriptRef.current);
  };

  const endInterview = useCallback(() => {
    if (!machine.transition("finished")) return;
    complete();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine]);

  // --- AI turn -------------------------------------------------------------------

  /** Opens the candidate's turn — only ever called after AI audio has fully ended. */
  const openCandidateTurn = (useMic: boolean) => {
    if (!machine.transition("waiting_for_candidate")) return;
    clearTimers();
    resetCandidateTranscript();
    lockedAnswerRef.current = null;
    setLockedAnswer(null);
    answerStartedAtRef.current = null;
    setAnswerStartedAt(null);
    setError(null);
    if (useMic && voice.isSupported) {
      setMicError(null);
      voice.start();
    }
  };

  /**
   * Speaks one interviewer line and resolves only after the actual audio
   * playback has ended (Web Audio `onended` of the last chunk). The mic is
   * closed for the whole time.
   */
  const speakLine = async (speech: PendingSpeech) => {
    if (!machine.transition("ai_speaking")) return;
    clearTimers();
    voice.abort();
    setError(null);
    setInterviewerLine(speech.text);
    pendingSpeechRef.current = speech;
    const token = ++speechTokenRef.current;

    const outcome = await tts.speak(speech.text);
    if (token !== speechTokenRef.current || !machine.is("ai_speaking")) return; // ended meanwhile

    if (outcome !== "completed") {
      // The voice failed (or was torn down underneath us): keep the mic closed
      // and offer to retry the same line.
      machine.transition("error");
      setError({
        kind: "speech",
        message: "The interviewer's voice could not be played.",
        canRetry: true,
      });
      return;
    }

    options.avatar.current?.stop();
    pendingSpeechRef.current = null;
    if (speech.then === "finish") {
      if (machine.transition("finished")) complete();
      return;
    }
    await delay(POST_AI_PAUSE_MS);
    if (token !== speechTokenRef.current || !machine.is("ai_speaking") || !mountedRef.current) return;
    openCandidateTurn(true);
  };

  // --- start ---------------------------------------------------------------------

  const runStart = async () => {
    if (!machine.transition("preparing")) return;
    setError(null);
    try {
      const res = await startInterview(analysis);
      if (!machine.is("preparing")) return;
      sessionIdRef.current = res.sessionId;
      callStartedAtRef.current = Date.now();
      turnIdRef.current = res.turnId;
      questionRef.current = res.firstQuestion;
      setTurnId(res.turnId);
      setQuestion(res.firstQuestion);
      setPersona(res.persona);
      setProgress(res.progress);
      const line = `${res.openingText} ${res.firstQuestion.text}`.trim();
      record("interviewer", line, res.firstQuestion.id);
      void speakLine({ text: line, then: "listen" });
    } catch (err) {
      if (!machine.is("preparing")) return;
      const e = err instanceof ApiRequestError ? err : null;
      machine.transition("error");
      setError({
        kind: e && TERMINAL_CODES.has(e.code) ? "session" : "start",
        message: e?.message ?? "The interviewer could not start.",
        canRetry: !(e && TERMINAL_CODES.has(e.code)),
      });
    }
  };

  // React Strict Mode runs effects twice in development; the ref keeps this
  // to one start request (the server de-duplicates /start as well).
  useEffect(() => {
    mountedRef.current = true;
    if (!startedRef.current) {
      startedRef.current = true;
      void runStart();
    }
    return () => {
      mountedRef.current = false;
      // Strict Mode remounts synchronously; only a real unmount tears down.
      setTimeout(() => {
        if (mountedRef.current) return;
        clearTimers();
        speechTokenRef.current++;
        activeRequestIdRef.current = null;
        requestAbortRef.current?.abort();
      }, 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- answer submission -------------------------------------------------------

  /** Sends the locked answer for its own turn. Also used by "Retry". */
  const submitLockedAnswer = async () => {
    const locked = lockedAnswerRef.current;
    if (!locked || !machine.transition("processing_answer")) return;
    setError(null);

    requestAbortRef.current?.abort();
    const controller = new AbortController();
    requestAbortRef.current = controller;
    const requestId = newId();
    activeRequestIdRef.current = requestId;

    try {
      const res = await interviewApi.respond(
        {
          sessionId: sessionIdRef.current,
          turnId: locked.turnId,
          questionId: locked.questionId,
          questionText: locked.questionText,
          candidateTranscript: locked.transcript,
          completionReason: locked.reason,
          elapsedSeconds: Math.round((Date.now() - callStartedAtRef.current) / 1000),
        },
        controller.signal
      );

      // Discard anything that isn't the response to this exact request/turn.
      if (activeRequestIdRef.current !== requestId) return;
      if (!machine.is("processing_answer") || turnIdRef.current !== locked.turnId) return;
      if (
        res.sessionId !== sessionIdRef.current ||
        res.turnId !== locked.turnId ||
        res.questionId !== locked.questionId
      ) {
        activeRequestIdRef.current = null;
        machine.transition("error");
        setError({ kind: "respond", message: "Received a response for a different question. Your answer was saved.", canRetry: true });
        return;
      }
      activeRequestIdRef.current = null;

      // Scoring the answer is a separate call, so the reply above is not held up by it.
      // The server keeps it with the session; losing it only leaves that answer unscored.
      try {
        void interviewApi.evaluate({ sessionId: res.sessionId, questionId: res.questionId }).catch(() => undefined);
      } catch {
        /* best effort */
      }

      if (!machine.transition("ready_for_ai")) return;
      setProgress(res.progress);

      if (res.shouldContinue && res.nextQuestion && res.nextTurnId !== null) {
        turnIdRef.current = res.nextTurnId;
        questionRef.current = res.nextQuestion;
        setTurnId(res.nextTurnId);
        setQuestion(res.nextQuestion);
        record("interviewer", res.conversationMessage, res.nextQuestion.id);
        // One combined line: brief acknowledgement + the next question.
        void speakLine({ text: res.conversationMessage, then: "listen" });
      } else {
        record("interviewer", res.conversationMessage);
        void speakLine({ text: res.conversationMessage, then: "finish" });
      }
    } catch (err) {
      if (activeRequestIdRef.current !== requestId || isCancelled(err)) return;
      activeRequestIdRef.current = null;
      if (!machine.is("processing_answer")) return;
      const e = err instanceof ApiRequestError ? err : null;
      const terminal = e ? TERMINAL_CODES.has(e.code) : false;
      const wait =
        e?.retryAfterSeconds && e.retryAfterSeconds < 600 ? ` You can retry in about ${e.retryAfterSeconds}s.` : "";
      machine.transition("error");
      setError({
        kind: terminal ? "session" : "respond",
        message: `Your answer was saved. ${e?.message ?? "The interviewer is temporarily unavailable."}${wait}`,
        canRetry: !terminal,
      });
    }
  };

  /**
   * The only way an answer ends. Closes the mic, waits for the recognizer's
   * last words, locks the transcript to the turn/question captured when the
   * turn began, then submits it exactly once.
   */
  const finishCandidateAnswer = async (reason: AnswerCompletionReason) => {
    if (machine.state !== "candidate_speaking" || isSubmittingAnswerRef.current) return;
    const q = questionRef.current;
    if (!q) return;
    isSubmittingAnswerRef.current = true;
    const capturedTurnId = turnIdRef.current;
    const capturedQuestion = q;

    try {
      clearTimers();
      if (!machine.transition("candidate_finished")) return;
      await voice.stopAndFlush();
      if (!machine.is("candidate_finished") || turnIdRef.current !== capturedTurnId) return;

      const transcript = finalTranscriptRef.current.trim();
      if (!transcript) {
        setNotice("I couldn't hear an answer. Please try again.");
        machine.transition("candidate_speaking");
        if (voice.isSupported) voice.start();
        return;
      }

      interimTranscriptRef.current = "";
      setInterimTranscript("");
      lockedAnswerRef.current = {
        turnId: capturedTurnId,
        questionId: capturedQuestion.id,
        questionText: capturedQuestion.text,
        transcript,
        reason,
      };
      setLockedAnswer(transcript);
      record("candidate", transcript, capturedQuestion.id);
    } finally {
      isSubmittingAnswerRef.current = false;
    }
    void submitLockedAnswer();
  };
  finishAnswerRef.current = (reason) => void finishCandidateAnswer(reason);

  /** Typed answers join the same turn and go through the same single submit path. */
  const submitTypedAnswer = (text: string) => {
    const typed = text.trim();
    if (!typed || !machine.is(...LISTENING_STATES)) return;
    finalTranscriptRef.current = appendFinalChunk(finalTranscriptRef.current, typed);
    setFinalTranscript(finalTranscriptRef.current);
    onCandidateActivity();
    void finishCandidateAnswer("typed");
  };

  // --- recovery ----------------------------------------------------------------

  const retry = () => {
    if (machine.state !== "error" || !error?.canRetry) return;
    if (error.kind === "start") void runStart();
    else if (error.kind === "respond") void submitLockedAnswer();
    else if (error.kind === "speech" && pendingSpeechRef.current) void speakLine(pendingSpeechRef.current);
  };

  /** After a voice failure: show the line as text and let the candidate answer by typing. */
  const continueWithoutVoice = () => {
    const pending = pendingSpeechRef.current;
    if (machine.state !== "error" || error?.kind !== "speech" || !pending) return;
    pendingSpeechRef.current = null;
    if (pending.then === "finish") {
      if (machine.transition("finished")) complete();
      return;
    }
    openCandidateTurn(false);
  };

  useEffect(() => {
    return () => clearTimers();
  }, []);

  return {
    state,
    turnId,
    question,
    persona,
    progress,
    interviewerLine,
    finalTranscript,
    interimTranscript,
    lockedAnswer,
    notice,
    micError,
    error,
    answerStartedAt,
    tts,
    voice,
    finishAnswer: () => void finishCandidateAnswer("manual"),
    submitTypedAnswer,
    retry,
    continueWithoutVoice,
    endInterview,
  };
}
