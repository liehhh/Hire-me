import { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { Mic, MicOff, PhoneOff, AlertTriangle, Video, VideoOff } from "lucide-react";
import { AvatarContainer, type AvatarHandle, type SpeechAudio } from "./AvatarContainer";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";
import type { InitInterviewResponse } from "../types";

const SOCKET_URL = import.meta.env.VITE_SERVER_URL ?? "http://localhost:4001";

// How long to wait after the candidate stops talking before treating their
// utterance as "done" and sending it to the interviewer. Real speech has
// natural pauses mid-thought; without this, every short pause would get
// fired off as a separate (incomplete) answer.
const SILENCE_BEFORE_SEND_MS = 1800;

// Grace window right after the avatar starts talking where we ignore mic
// input outright — this is when speaker bleed-in is most likely to trigger
// a false "barge-in" before the echo-overlap check below even has a full
// phrase to compare against.
const BARGE_IN_GRACE_MS = 400;

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean);
}

// Heuristic echo guard: since the mic stays live while the avatar talks (so
// the candidate can genuinely interrupt), without headphones it can also
// pick up the avatar's own voice from the speakers. If what was "heard"
// overlaps heavily with what the avatar is currently saying, treat it as
// self-echo rather than a real interruption.
function looksLikeEcho(heard: string, aiText: string): boolean {
  const heardWords = normalizeWords(heard);
  if (heardWords.length === 0) return true;
  const aiWords = new Set(normalizeWords(aiText));
  const overlapCount = heardWords.filter((w) => aiWords.has(w)).length;
  return overlapCount / heardWords.length >= 0.6;
}

interface CallRoomProps {
  session: InitInterviewResponse;
  onEndCall: () => void;
}

interface CaptionEntry {
  speaker: "interviewer" | "candidate";
  text: string;
}

export function CallRoom({ session, onEndCall }: CallRoomProps) {
  const avatarRef = useRef<AvatarHandle>(null);
  const socketRef = useRef<Socket | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isAvatarSpeaking, setIsAvatarSpeaking] = useState(false);
  const [caption, setCaption] = useState<CaptionEntry | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [micLevel, setMicLevel] = useState(0);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);

  const pendingUtteranceRef = useRef("");
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentAiTextRef = useRef("");
  const avatarSpeechStartedAtRef = useRef(0);

  const flushPendingUtterance = () => {
    const text = pendingUtteranceRef.current.trim();
    pendingUtteranceRef.current = "";
    if (!text) return;
    socketRef.current?.emit("candidate-speech-transcript", { text });
  };

  // Mic stays live even while the avatar is talking, so the candidate can
  // genuinely interrupt mid-sentence like in a real conversation — pausing
  // recognition during avatar speech would mean any barge-in gets ignored.
  // (Trade-off: without headphones, the mic can pick up the avatar's own
  // TTS output; the grace window + echo-overlap check below filter that
  // out so the AI doesn't interrupt itself.)
  const { isSupported, isListening, interimText } = useSpeechRecognition({
    paused: isMuted,
    onFinalTranscript: (text) => {
      if (avatarRef.current?.isSpeaking()) {
        const withinGrace = Date.now() - avatarSpeechStartedAtRef.current < BARGE_IN_GRACE_MS;
        if (withinGrace || looksLikeEcho(text, currentAiTextRef.current)) {
          return; // self-echo, not a real interruption — ignore entirely
        }
        avatarRef.current.interrupt();
      }

      pendingUtteranceRef.current = pendingUtteranceRef.current
        ? `${pendingUtteranceRef.current} ${text}`
        : text;
      setCaption({ speaker: "candidate", text: pendingUtteranceRef.current });

      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = setTimeout(flushPendingUtterance, SILENCE_BEFORE_SEND_MS);
    },
  });

  useEffect(() => {
    return () => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    };
  }, []);

  // Socket.io lifecycle: connect once per call, tear down on unmount/end.
  useEffect(() => {
    const socket = io(SOCKET_URL, { transports: ["websocket"] });
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("start-interview", session.rubricId);
    });

    socket.on(
      "ai-response-spoken",
      ({ text, audio }: { text: string; audio?: SpeechAudio | null }) => {
        setCaption({ speaker: "interviewer", text });
        currentAiTextRef.current = text;
        avatarRef.current?.speakText(text, audio);
      }
    );

    socket.on("interview-error", ({ message }: { message: string }) => {
      setConnectionError(message);
    });

    socket.on("connect_error", () => {
      setConnectionError("Unable to reach the interview server.");
    });

    return () => {
      socket.disconnect();
    };
  }, [session.rubricId]);

  // Live mic-level visualizer: a lightweight WebAudio analyser, independent
  // of speech recognition, purely for the waveform indicator.
  useEffect(() => {
    if (isMuted) {
      setMicLevel(0);
      return;
    }

    let audioContext: AudioContext | null = null;
    let stream: MediaStream | null = null;
    let rafId: number;
    let analyser: AnalyserNode;

    async function setupMeter() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(stream);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);

        const data = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteFrequencyData(data);
          const avg = data.reduce((sum, v) => sum + v, 0) / data.length;
          setMicLevel(avg / 255);
          rafId = requestAnimationFrame(tick);
        };
        tick();
      } catch (err) {
        console.warn("Microphone access unavailable for visualizer:", err);
      }
    }

    setupMeter();

    return () => {
      cancelAnimationFrame(rafId);
      stream?.getTracks().forEach((t) => t.stop());
      audioContext?.close();
    };
  }, [isMuted]);

  // Local-only camera self-view. Nothing here is streamed to the server or
  // the AI — it's purely a picture-in-picture preview, same as any video
  // call UI, toggled independently of the microphone.
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
      .catch((err) => {
        console.warn("Camera access denied or unavailable:", err);
        if (!cancelled) setIsCameraOn(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isCameraOn]);

  useEffect(() => {
    return () => {
      cameraStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const handleEndCall = () => {
    socketRef.current?.disconnect();
    onEndCall();
  };

  return (
    <div className="flex h-full w-full flex-col gap-4 p-4">
      {connectionError && (
        <div className="flex items-center gap-2 rounded-lg bg-red-950/60 px-4 py-2 text-sm text-red-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {connectionError}
        </div>
      )}

      {!isSupported && (
        <div className="flex items-center gap-2 rounded-lg bg-amber-950/60 px-4 py-2 text-sm text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Your browser doesn't support Web Speech API voice input. Try Chrome or Edge for
          the full voice experience.
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-4">
        <div className="relative flex-1">
          <AvatarContainer
            ref={avatarRef}
            onSpeakingChange={(speaking) => {
              if (speaking) avatarSpeechStartedAtRef.current = Date.now();
              setIsAvatarSpeaking(speaking);
            }}
          />

          {/* Self-view camera thumbnail, picture-in-picture style */}
          {isCameraOn && (
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="absolute bottom-3 right-3 h-32 w-44 rounded-lg border border-slate-700 bg-slate-800 object-cover shadow-lg"
            />
          )}
        </div>

        <aside className="flex w-64 shrink-0 flex-col gap-3 rounded-xl bg-slate-900 p-4 text-slate-200">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">Interviewer</p>
            <p className="font-semibold">{session.interviewerPersona.name}</p>
            <p className="text-sm text-slate-400">{session.interviewerPersona.title}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">Level</p>
            <p className="text-sm text-slate-400">{session.seniorityLevel}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">Evaluating</p>
            <ul className="mt-1 space-y-1 text-sm text-slate-400">
              {session.keyCompetencies.map((c) => (
                <li key={c}>• {c}</li>
              ))}
            </ul>
          </div>
        </aside>
      </div>

      {/* Closed-caption bar */}
      <div className="min-h-[3.5rem] rounded-lg bg-slate-900/80 px-4 py-3 text-center text-sm text-slate-200">
        {caption ? (
          <span>
            <span className="font-semibold text-slate-400">
              {caption.speaker === "interviewer" ? session.interviewerPersona.name : "You"}:
            </span>{" "}
            {caption.text}
          </span>
        ) : interimText ? (
          <span className="text-slate-500 italic">{interimText}</span>
        ) : (
          <span className="text-slate-600">Listening...</span>
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center justify-center gap-4">
        <div className="flex items-center gap-2 rounded-full bg-slate-900 px-4 py-2">
          <div className="flex h-6 w-24 items-end gap-0.5">
            {Array.from({ length: 12 }).map((_, i) => {
              const barThreshold = i / 12;
              const active = !isMuted && micLevel > barThreshold;
              return (
                <div
                  key={i}
                  className={`w-1 flex-1 rounded-sm transition-all ${
                    active ? "bg-emerald-400" : "bg-slate-700"
                  }`}
                  style={{ height: active ? `${30 + barThreshold * 70}%` : "20%" }}
                />
              );
            })}
          </div>
          <span className="text-xs text-slate-500">
            {isListening ? "live" : isMuted ? "muted" : "idle"}
          </span>
        </div>

        <button
          onClick={() => setIsMuted((m) => !m)}
          className={`flex h-12 w-12 items-center justify-center rounded-full transition-colors ${
            isMuted ? "bg-slate-700 text-slate-300" : "bg-emerald-600 text-white"
          }`}
          aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}
        >
          {isMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
        </button>

        <button
          onClick={() => setIsCameraOn((c) => !c)}
          className={`flex h-12 w-12 items-center justify-center rounded-full transition-colors ${
            isCameraOn ? "bg-emerald-600 text-white" : "bg-slate-700 text-slate-300"
          }`}
          aria-label={isCameraOn ? "Turn camera off" : "Turn camera on"}
        >
          {isCameraOn ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
        </button>

        <button
          onClick={handleEndCall}
          className="flex h-12 w-12 items-center justify-center rounded-full bg-red-600 text-white transition-colors hover:bg-red-500"
          aria-label="End call"
        >
          <PhoneOff className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
