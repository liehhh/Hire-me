"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, AlertTriangle, RotateCcw } from "lucide-react";
import { SetupForm } from "./components/SetupForm";
import { InterviewPrep } from "./components/InterviewPrep";
import { CallRoom } from "./components/CallRoom";
import { FeedbackDashboard } from "./components/FeedbackDashboard";
import { ApiRequestError, interviewApi } from "./api/interviewApi";
import { breadcrumb } from "./lib/debugLog";
import { TtsDiagnostics } from "./components/TtsDiagnostics";
import type { AnalyzeResponse, InterviewReport, TranscriptTurn } from "./types";

interface FinishedInterview {
  sessionId: string;
  transcript: TranscriptTurn[];
}

type View =
  | { name: "setup" }
  | { name: "prep"; analysis: AnalyzeResponse }
  | { name: "call"; analysis: AnalyzeResponse }
  | { name: "evaluating"; finished: FinishedInterview }
  | { name: "report-error"; finished: FinishedInterview; message: string; canRetry: boolean }
  | { name: "feedback"; report: InterviewReport };

// The prepared interview survives the browser reloading the page (for example
// when iOS terminates the tab): it returns to the prep screen rather than the
// empty setup form. A call is restored as "prep" so the interview only starts
// from a fresh tap, which also unlocks audio.
const RESUME_KEY = "interview-resume";

function persistView(view: View): void {
  try {
    if (view.name === "prep" || view.name === "call") {
      sessionStorage.setItem(RESUME_KEY, JSON.stringify(view.analysis));
    } else {
      sessionStorage.removeItem(RESUME_KEY);
    }
  } catch {
    // Storage unavailable: resume just won't work.
  }
}

export default function App() {
  const [view, setViewState] = useState<View>({ name: "setup" });
  const [diag, setDiag] = useState(false);
  const setView = (next: View) => {
    breadcrumb(`view: ${next.name}`);
    persistView(next);
    setViewState(next);
  };

  useEffect(() => {
    setDiag(new URLSearchParams(location.search).get("diag") === "1");
    try {
      const saved = sessionStorage.getItem(RESUME_KEY);
      if (saved) {
        breadcrumb("view: restored prep screen after reload");
        setViewState({ name: "prep", analysis: JSON.parse(saved) as AnalyzeResponse });
      }
    } catch {
      // ignore
    }
  }, []);

  // One report request at a time; the server also refuses to regenerate a
  // report unless asked to retry explicitly.
  const finishingRef = useRef(false);

  const requestReport = async (finished: FinishedInterview, retry: boolean) => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    setView({ name: "evaluating", finished });
    try {
      const { report } = await interviewApi.finish({ ...finished, retry });
      setView({ name: "feedback", report });
    } catch (err) {
      const e = err instanceof ApiRequestError ? err : null;
      setView({
        name: "report-error",
        finished,
        message: e?.message ?? "Failed to generate the report.",
        canRetry: e?.retryable ?? true,
      });
    } finally {
      finishingRef.current = false;
    }
  };

  if (diag) return <TtsDiagnostics />;

  return (
    <main className="min-h-dvh">
      {view.name === "setup" && <SetupForm onAnalyzed={(analysis) => setView({ name: "prep", analysis })} />}

      {view.name === "prep" && (
        <InterviewPrep
          analysis={view.analysis}
          onBack={() => setView({ name: "setup" })}
          onStart={() => setView({ name: "call", analysis: view.analysis })}
        />
      )}

      {view.name === "call" && (
        <CallRoom
          analysis={view.analysis}
          onEnd={(sessionId, transcript) => void requestReport({ sessionId, transcript }, false)}
        />
      )}

      {view.name === "evaluating" && (
        <div className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">
          <h1 className="display animate-rise !text-[clamp(2.5rem,8vw,7rem)]">Writing your report.</h1>
          <p className="mt-6 flex items-center gap-2 text-xl text-mute">
            <Loader2 className="h-5 w-5 animate-spin" /> Grounded in what you actually said. Up to a minute.
          </p>
        </div>
      )}

      {view.name === "report-error" && (
        <div className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">
          <AlertTriangle className="mb-6 h-10 w-10 text-red-500" />
          <h1 className="display animate-rise !text-[clamp(2.5rem,7vw,6rem)]">That didn't work.</h1>
          <p className="mt-6 max-w-xl text-xl text-mute">{view.message}</p>
          <p className="mt-2 text-[15px] text-mute">Your transcript is saved — retrying won't lose it.</p>
          <div className="mt-10 flex gap-3">
            {view.canRetry && (
              <button onClick={() => void requestReport(view.finished, true)} className="btn-primary">
                <RotateCcw className="h-4 w-4" /> Retry report
              </button>
            )}
            <button onClick={() => setView({ name: "setup" })} className="btn-quiet !px-8 !py-4 !text-[17px]">
              Start over
            </button>
          </div>
        </div>
      )}

      {view.name === "feedback" && <FeedbackDashboard report={view.report} onRestart={() => setView({ name: "setup" })} />}
    </main>
  );
}
