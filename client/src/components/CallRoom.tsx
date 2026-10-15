"use client";

import { useEffect, useRef, useState } from "react";
import {
  Mic,
  MicOff,
  PhoneOff,
  AlertTriangle,
  Video,
  VideoOff,
  Loader2,
  RotateCcw,
  Volume2,
  Send,
  Check,
  CheckCircle2,
  FileText,
  Keyboard,
} from "lucide-react";
import { breadcrumb } from "../lib/debugLog";
import { AvatarContainer } from "./AvatarContainer";
import { humanize } from "./InterviewPrep";
import type { AvatarSpeechAdapter } from "../features/avatar/AvatarSpeechAdapter";
import { useConversation } from "../features/conversation/useConversation";
import { LISTENING_STATES, type ConversationState } from "../features/conversation/conversationMachine";
import type { AnalyzeResponse, TranscriptTurn } from "../types";

interface CallRoomProps {
  analysis: AnalyzeResponse;
  onEnd: (sessionId: string, transcript: TranscriptTurn[]) => void;
}

const formatClock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Whose turn it is, in the candidate's words. */
const TURN_LABEL: Record<ConversationState, string> = {
  idle: "Getting ready",
  preparing: "Preparing the first question",
  ai_speaking: "Interviewer is speaking",
  waiting_for_candidate: "Your turn",
  candidate_speaking: "Your turn",
  candidate_finished: "Finishing your answer",
  processing_answer: "Reviewing your answer",
  ready_for_ai: "Interviewer is responding",
  finished: "Interview complete",
  error: "Paused",
};

const TURN_STYLE: Partial<Record<ConversationState, string>> = {
  ai_speaking: "bg-white/90 text-black",
  waiting_for_candidate: "bg-accent text-white",
  candidate_speaking: "bg-accent text-white",
  processing_answer: "bg-white/15 text-white",
  ready_for_ai: "bg-white/15 text-white",
  candidate_finished: "bg-white/15 text-white",
  error: "bg-[#ff453a] text-white",
};

export function CallRoom({ analysis, onEnd }: CallRoomProps) {
  const avatarRef = useRef<AvatarSpeechAdapter>(null);
  const convo = useConversation({ analysis, avatar: avatarRef, onEnd });
  const { state, tts, voice } = convo;

  const [micLevel, setMicLevel] = useState(0);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [typedAnswer, setTypedAnswer] = useState("");
  const [now, setNow] = useState(Date.now());
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);

  const isListening = LISTENING_STATES.includes(state);
  const hasSpeech = Boolean(convo.finalTranscript.trim() || convo.interimTranscript.trim());

  // Recording clock while the candidate has the floor.
  useEffect(() => {
    if (state !== "candidate_speaking") return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [state]);

  // Mic-level visualizer — only while the candidate's turn is open, so the
  // meter never suggests the mic is live while the interviewer speaks.
  useEffect(() => {
    if (!isListening) {
      setMicLevel(0);
      return;
    }
    let audioContext: AudioContext | null = null;
    let stream: MediaStream | null = null;
    let rafId = 0;
    let disposed = false;

    (async () => {
      try {
        breadcrumb("mic: level meter getUserMedia");
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        breadcrumb("mic: level meter granted");
        if (disposed) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        audioContext = new AudioContext();
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        audioContext.createMediaStreamSource(stream).connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteFrequencyData(data);
          setMicLevel(data.reduce((sum, v) => sum + v, 0) / data.length / 255);
          rafId = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        // Visualizer only — recognition reports real mic problems.
      }
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      stream?.getTracks().forEach((t) => t.stop());
      void audioContext?.close();
    };
  }, [isListening]);

  // Local-only camera self-view. Nothing here is streamed to the server or
  // the AI — it's purely a picture-in-picture preview.
  useEffect(() => {
    if (!isCameraOn) {
      cameraStreamRef.current?.getTracks().forEach((t) => t.stop());
      cameraStreamRef.current = null;
      return;
    }
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ video: true })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        cameraStreamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      })
      .catch(() => {
        if (!cancelled) setIsCameraOn(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isCameraOn]);

  useEffect(() => () => cameraStreamRef.current?.getTracks().forEach((t) => t.stop()), []);

  const submitTyped = (e: React.FormEvent) => {
    e.preventDefault();
    if (!typedAnswer.trim() || !isListening) return;
    convo.submitTypedAnswer(typedAnswer);
    setTypedAnswer("");
  };

  const voiceStatus =
    state === "ai_speaking" && tts.isLoadingModel
      ? tts.progress !== null && tts.progress < 100
        ? `Downloading voice model… ${tts.progress}%`
        : "Preparing interviewer voice…"
      : state === "ai_speaking" && !tts.isSpeaking
        ? "Generating speech…"
        : null;

  const recordedMs = convo.answerStartedAt ? now - convo.answerStartedAt : 0;
  const plan = analysis.interviewBlueprint;
  const progress = convo.progress;
  const totalEstimate = progress ? progress.questionsAsked + progress.estimatedQuestionsRemaining : 0;
  const progressPct = progress && totalEstimate > 0 ? Math.min(100, (progress.questionsAsked / totalEstimate) * 100) : 0;
  const elapsedMin = progress?.elapsedMinutes ?? 0;

  // What the candidate sees in the transcript area.
  const showCandidateText = isListening || state === "candidate_finished";
  const liveText = `${convo.finalTranscript}${convo.interimTranscript ? ` ${convo.interimTranscript}` : ""}`.trim();

  const banner = "flex flex-wrap items-center gap-3 rounded-2xl px-5 py-3 text-[15px] glass";
  const bannerBtn = "flex shrink-0 items-center gap-1.5 rounded-full bg-white/15 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-white/25";

  return (
    <div className="flex h-dvh w-full flex-col gap-3 bg-black p-3 text-white sm:p-4">
      {convo.error && (
        <div role="alert" className={`${banner} !bg-red-500/20 text-red-100`}>
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="flex-1">{convo.error.message}</span>
          {convo.error.canRetry && (
            <button onClick={convo.retry} className={bannerBtn}>
              <RotateCcw className="h-3.5 w-3.5" />
              {convo.error.kind === "respond"
                ? "Retry interviewer response"
                : convo.error.kind === "speech"
                  ? "Retry voice"
                  : "Retry"}
            </button>
          )}
          {convo.error.kind === "speech" && (
            <button onClick={convo.continueWithoutVoice} className={bannerBtn}>
              <Keyboard className="h-3.5 w-3.5" /> Continue in text mode
            </button>
          )}
          <button onClick={convo.endInterview} className={bannerBtn}>
            End &amp; get report
          </button>
        </div>
      )}

      {voice.engine === "whisper" && voice.modelStatus === "loading" && (
        <div className={`${banner} text-amber-200`}>
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Your browser doesn't support the Web Speech API — loading an on-device speech recognition model as a
          fallback (one-time download, runs fully offline afterward).
        </div>
      )}

      {tts.needsAudioUnlock && (
        <div className={`${banner} text-amber-200`}>
          <Volume2 className="h-4 w-4 shrink-0" />
          <span className="flex-1">Your browser blocked audio playback for the interviewer.</span>
          <button onClick={() => void tts.enableAudio()} className={bannerBtn}>
            Enable interviewer audio
          </button>
        </div>
      )}

      {(convo.micError || !voice.isSupported) && isListening && (
        <div className={`${banner} text-amber-200`}>
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {convo.micError ?? "Voice input isn't available in this browser — type your answer below."}
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-3 sm:gap-4">
        <div className="relative min-w-0 flex-1">
          <AvatarContainer ref={avatarRef} />

          <div className="absolute left-5 top-5 flex flex-col items-start gap-2">
            <span
              className={`inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium backdrop-blur-2xl ${
                TURN_STYLE[state] ?? "bg-white/10 text-white/70"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full bg-current ${state === "ai_speaking" || state === "candidate_speaking" ? "animate-pulse" : ""}`} />
              {TURN_LABEL[state]}
            </span>
            {(voiceStatus || state === "preparing" || state === "processing_answer" || state === "ready_for_ai") && (
              <span className="flex items-center gap-2 rounded-full bg-black/40 px-4 py-1.5 text-sm text-white/70 backdrop-blur-2xl">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {voiceStatus ??
                  (state === "preparing"
                    ? "Interviewer is preparing…"
                    : state === "processing_answer"
                      ? "Reviewing your answer…"
                      : "Preparing the response…")}
              </span>
            )}
          </div>

          {isCameraOn && (
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="absolute right-5 top-5 h-32 w-44 rounded-2xl bg-neutral-900 object-cover shadow-2xl ring-1 ring-white/20"
            />
          )}

          {/* The question, set large like a caption — the answer is always tied to this exact question. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 rounded-b-[32px] bg-gradient-to-t from-black/85 via-black/50 to-transparent px-6 pb-6 pt-24 sm:px-10 sm:pb-8">
            <p className="mb-2 text-sm font-medium text-white/50">{convo.persona?.name ?? "Interviewer"}</p>
            <p className="max-w-4xl text-[clamp(1.25rem,2.6vw,2.25rem)] font-semibold leading-tight tracking-tight">
              {convo.interviewerLine || <span className="text-white/30">…</span>}
            </p>
          </div>
        </div>

        <aside className="hidden w-72 shrink-0 flex-col gap-7 overflow-y-auto rounded-[32px] bg-[#1c1c1e] p-7 lg:flex">
          <div>
            <p className="text-sm text-white/40">Interviewer</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight">{convo.persona?.name ?? "…"}</p>
            <p className="text-[15px] text-white/50">{analysis.jobProfile.normalizedTitle}</p>
          </div>
          <div>
            <p className="text-5xl font-semibold tracking-[-0.04em] tabular-nums">
              {progress?.questionsAsked ?? 0}
              {totalEstimate > 0 && <span className="text-2xl text-white/30"> / ~{totalEstimate}</span>}
            </p>
            <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-white transition-all" style={{ width: `${progressPct}%` }} />
            </div>
            <p className="mt-2 text-sm text-white/40">
              {elapsedMin} / ~{plan.estimatedDurationMinutes} min
            </p>
          </div>
          <div>
            <p className="text-sm text-white/40">Stage</p>
            <p className="mt-0.5 text-[17px]">{progress ? humanize(progress.currentStage) : "—"}</p>
          </div>
          <div>
            <p className="text-sm text-white/40">Current focus</p>
            <p className="mt-0.5 text-[17px]">{convo.question?.competency ?? "—"}</p>
            {convo.question?.isFollowUp && <p className="text-sm text-white/40">Follow-up</p>}
          </div>
          <div>
            <p className="mb-2 text-sm text-white/40">Competencies</p>
            <ul className="space-y-1.5 text-[15px]">
              {plan.competencyWeights.map((c) => {
                const covered = progress?.competenciesCovered.includes(c.competency);
                return (
                  <li key={c.competency} className={`flex items-center gap-2 ${covered ? "text-white" : "text-white/35"}`}>
                    {covered ? <Check className="h-4 w-4 text-[#30d158]" /> : <span className="h-4 w-4" />}
                    {c.competency}
                  </li>
                );
              })}
            </ul>
          </div>
        </aside>
      </div>

      {/* Control bar: [mic status] [live transcript] [Done speaking] */}
      <div className="flex flex-col gap-3 rounded-[28px] bg-[#1c1c1e] p-3 md:flex-row md:items-center">
        <div className="flex w-full shrink-0 items-center gap-3 pl-1 md:w-56">
          <div
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${
              isListening ? "bg-accent text-white" : "bg-white/10 text-white/40"
            }`}
          >
            {isListening ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
          </div>
          <div className="min-w-0">
            <p className="text-[15px] font-medium">
              {state === "candidate_speaking"
                ? `Recording ${formatClock(recordedMs)}`
                : state === "waiting_for_candidate"
                  ? "Microphone on"
                  : "Microphone off"}
            </p>
            <p className="text-xs text-white/40">
              {state === "candidate_speaking"
                ? "Take as long as you need"
                : state === "waiting_for_candidate"
                  ? "Speak as long as you need"
                  : state === "processing_answer"
                    ? "Answer submitted"
                    : "Wait for your turn"}
            </p>
            {isListening && (
              <div className="mt-1.5 flex h-1.5 w-24 items-end gap-0.5">
                {Array.from({ length: 12 }).map((_, i) => (
                  <div key={i} className={`h-full flex-1 rounded-full ${micLevel > i / 12 ? "bg-accent" : "bg-white/15"}`} />
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="min-h-[3.25rem] max-h-32 flex-1 overflow-y-auto rounded-2xl bg-black/50 px-4 py-3 text-[15px] leading-relaxed">
          {state === "processing_answer" || state === "ready_for_ai" ? (
            <p className="text-white/80">
              <CheckCircle2 className="mr-1.5 inline h-4 w-4 text-[#30d158]" />
              <span className="text-white/40">Submitted: </span>
              {convo.lockedAnswer}
            </p>
          ) : convo.error?.kind === "respond" && convo.lockedAnswer ? (
            <p className="text-white/80">
              <span className="text-white/40">Saved answer: </span>
              {convo.lockedAnswer}
            </p>
          ) : showCandidateText && liveText ? (
            <p>
              {convo.finalTranscript}
              {convo.interimTranscript && <span className="text-white/40"> {convo.interimTranscript}</span>}
            </p>
          ) : (
            <p className="text-white/40">
              {convo.notice ??
                (isListening
                  ? "Your turn — speak as long as you need, then click Done speaking."
                  : state === "ai_speaking"
                    ? "Listen to the question. Your microphone opens when the interviewer finishes."
                    : "")}
            </p>
          )}
          {convo.notice && liveText && <p className="mt-1 text-xs text-amber-300">{convo.notice}</p>}
        </div>

        <button
          onClick={convo.finishAnswer}
          disabled={state !== "candidate_speaking" || !hasSpeech}
          className="flex h-12 shrink-0 items-center justify-center gap-2 rounded-full bg-accent px-7 text-[15px] font-medium text-white transition hover:bg-[#0077ed] active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/30"
        >
          <Check className="h-4 w-4" /> Done speaking
        </button>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-3 pb-1">
        <form onSubmit={submitTyped} className="flex min-w-0 max-w-xl flex-1 gap-2">
          <input
            value={typedAnswer}
            onChange={(e) => setTypedAnswer(e.target.value)}
            disabled={!isListening}
            placeholder={isListening ? "Or type your answer…" : "Typing opens on your turn"}
            maxLength={60_000}
            className="min-w-0 flex-1 rounded-full bg-[#1c1c1e] px-5 py-3 text-[15px] text-white outline-none transition placeholder:text-white/30 focus:ring-2 focus:ring-accent disabled:opacity-40"
          />
          <button
            type="submit"
            disabled={!typedAnswer.trim() || !isListening}
            className="flex h-12 w-12 items-center justify-center rounded-full bg-[#1c1c1e] text-white transition hover:bg-white/15 disabled:opacity-30"
            aria-label="Submit typed answer"
          >
            <Send className="h-4 w-4" />
          </button>
        </form>

        <button
          onClick={() => setIsCameraOn((c) => !c)}
          className={`flex h-12 w-12 items-center justify-center rounded-full transition ${
            isCameraOn ? "bg-white text-black" : "bg-[#1c1c1e] text-white hover:bg-white/15"
          }`}
          aria-label={isCameraOn ? "Turn camera off" : "Turn camera on"}
        >
          {isCameraOn ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
        </button>

        <button
          onClick={convo.endInterview}
          className={`flex h-12 items-center gap-2 rounded-full px-6 text-[15px] font-medium text-white transition active:scale-[0.98] ${
            state === "finished" ? "bg-accent hover:bg-[#0077ed]" : "bg-[#ff453a] hover:bg-[#ff5c52]"
          }`}
          aria-label="End interview"
        >
          {state === "finished" ? <FileText className="h-4 w-4" /> : <PhoneOff className="h-4 w-4" />}
          End interview
        </button>
      </div>
    </div>
  );
}
