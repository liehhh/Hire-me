import { useState } from "react";
import { Loader2, AlertTriangle } from "lucide-react";
import { SetupForm } from "./components/SetupForm";
import { CallRoom } from "./components/CallRoom";
import { FeedbackDashboard } from "./components/FeedbackDashboard";
import type { EvaluationReport, InitInterviewResponse } from "./types";

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "http://localhost:4001";

type View =
  | { name: "setup" }
  | { name: "call"; session: InitInterviewResponse }
  | { name: "evaluating"; session: InitInterviewResponse }
  | { name: "feedback"; report: EvaluationReport }
  | { name: "error"; message: string };

export default function App() {
  const [view, setView] = useState<View>({ name: "setup" });

  const handleEndCall = async (session: InitInterviewResponse) => {
    setView({ name: "evaluating", session });
    try {
      const res = await fetch(`${SERVER_URL}/api/interview/evaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rubricId: session.rubricId }),
      });
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      const report = (await res.json()) as EvaluationReport;
      setView({ name: "feedback", report });
    } catch (err) {
      setView({
        name: "error",
        message: err instanceof Error ? err.message : "Failed to generate evaluation.",
      });
    }
  };

  return (
    <div className="h-screen w-screen bg-slate-950">
      {view.name === "setup" && (
        <SetupForm onReady={(session) => setView({ name: "call", session })} />
      )}

      {view.name === "call" && (
        <CallRoom session={view.session} onEndCall={() => handleEndCall(view.session)} />
      )}

      {view.name === "evaluating" && (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-slate-300">
          <Loader2 className="h-8 w-8 animate-spin" />
          <p>Scoring your interview...</p>
        </div>
      )}

      {view.name === "feedback" && (
        <FeedbackDashboard report={view.report} onRestart={() => setView({ name: "setup" })} />
      )}

      {view.name === "error" && (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-slate-300">
          <AlertTriangle className="h-8 w-8 text-red-400" />
          <p>{view.message}</p>
          <button
            onClick={() => setView({ name: "setup" })}
            className="rounded-lg bg-slate-800 px-4 py-2 text-sm hover:bg-slate-700"
          >
            Start Over
          </button>
        </div>
      )}
    </div>
  );
}
