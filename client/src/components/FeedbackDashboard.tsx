import { useState } from "react";
import { ChevronDown, ChevronUp, ThumbsUp, TrendingUp, RotateCcw, Gauge } from "lucide-react";
import type { EvaluationReport, HiringVerdict } from "../types";

interface FeedbackDashboardProps {
  report: EvaluationReport;
  onRestart: () => void;
}

function scoreColor(score: number, max: number) {
  const pct = score / max;
  if (pct >= 0.75) return "bg-emerald-500";
  if (pct >= 0.5) return "bg-amber-500";
  return "bg-red-500";
}

const verdictStyles: Record<HiringVerdict["recommendation"], string> = {
  "Strong Hire": "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  Hire: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  "Leaning No Hire": "bg-amber-500/10 text-amber-300 border-amber-500/30",
  "No Hire": "bg-red-500/10 text-red-300 border-red-500/30",
};

export function FeedbackDashboard({ report, onRestart }: FeedbackDashboardProps) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-6 overflow-y-auto px-6 py-10">
      <div className="text-center">
        <p className="text-sm uppercase tracking-wide text-slate-500">
          Performance Evaluation
        </p>
        <div className="mt-2 text-6xl font-bold text-white">{report.overallScore}</div>
        <p className="text-slate-400">out of 100</p>
      </div>

      <section
        className={`rounded-xl border p-5 ${verdictStyles[report.hiringVerdict.recommendation]}`}
      >
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide">
          <Gauge className="h-4 w-4" /> Hiring Recommendation
        </h2>
        <div className="mb-2 flex items-baseline gap-3">
          <span className="text-xl font-bold">{report.hiringVerdict.recommendation}</span>
          <span className="text-sm opacity-80">
            {report.hiringVerdict.confidencePercent}% confidence
          </span>
        </div>
        <p className="text-sm leading-relaxed opacity-90">{report.hiringVerdict.summary}</p>
      </section>

      <section className="rounded-xl bg-slate-900 p-5">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-400">
          Competency Breakdown
        </h2>
        <div className="flex flex-col gap-3">
          {report.competencyScores.map(({ name, score, note }) => (
            <div key={name}>
              <div className="mb-1 flex items-center justify-between text-sm">
                <span className="font-medium text-slate-200">{name}</span>
                <span className="text-slate-400">{score}/10</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
                <div
                  className={`h-full rounded-full ${scoreColor(score, 10)}`}
                  style={{ width: `${(score / 10) * 100}%` }}
                />
              </div>
              <p className="mt-1 text-xs text-slate-500">{note}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <section className="rounded-xl bg-slate-900 p-5">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-emerald-400">
            <ThumbsUp className="h-4 w-4" /> Strengths
          </h2>
          <ul className="space-y-2 text-sm text-slate-300">
            {report.strengths.map((s, i) => (
              <li key={i}>• {s}</li>
            ))}
          </ul>
        </section>

        <section className="rounded-xl bg-slate-900 p-5">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-amber-400">
            <TrendingUp className="h-4 w-4" /> Areas for Improvement
          </h2>
          <ul className="space-y-2 text-sm text-slate-300">
            {report.areasForImprovement.map((s, i) => (
              <li key={i}>• {s}</li>
            ))}
          </ul>
        </section>
      </div>

      <section className="rounded-xl bg-slate-900 p-5">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-400">
          Question-by-Question Review
        </h2>
        <div className="flex flex-col divide-y divide-slate-800">
          {report.detailedQandA.map((qa, i) => {
            const isOpen = expandedIndex === i;
            return (
              <div key={i} className="py-3">
                <button
                  onClick={() => setExpandedIndex(isOpen ? null : i)}
                  className="flex w-full items-center justify-between gap-3 text-left"
                >
                  <span className="text-sm font-medium text-slate-200">{qa.question}</span>
                  {isOpen ? (
                    <ChevronUp className="h-4 w-4 shrink-0 text-slate-500" />
                  ) : (
                    <ChevronDown className="h-4 w-4 shrink-0 text-slate-500" />
                  )}
                </button>
                {isOpen && (
                  <div className="mt-3 flex flex-col gap-2 text-sm">
                    <p className="text-slate-400">
                      <span className="font-semibold text-slate-500">Your answer: </span>
                      {qa.candidateAnswer}
                    </p>
                    <p className="text-slate-400">
                      <span className="font-semibold text-slate-500">Critique: </span>
                      {qa.critique}
                    </p>
                    <p className="text-slate-400">
                      <span className="font-semibold text-slate-500">
                        Suggested stronger answer:{" "}
                      </span>
                      {qa.suggestedBetterAnswer}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <button
        onClick={onRestart}
        className="mx-auto flex items-center gap-2 rounded-lg bg-slate-800 px-5 py-2.5 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-700"
      >
        <RotateCcw className="h-4 w-4" />
        Start Another Interview
      </button>
    </div>
  );
}
