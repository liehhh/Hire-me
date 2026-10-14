"use client";

import { useState } from "react";
import { ChevronDown, RotateCcw } from "lucide-react";
import type { EvidenceBasedFinding, InterviewReport, Recommendation } from "../types";

interface FeedbackDashboardProps {
  report: InterviewReport;
  onRestart: () => void;
}

const RECOMMENDATION: Record<Recommendation, { label: string; dot: string }> = {
  strong_yes: { label: "Strong yes", dot: "bg-[#30d158]" },
  yes: { label: "Yes", dot: "bg-[#30d158]" },
  mixed: { label: "Mixed", dot: "bg-[#ff9f0a]" },
  no: { label: "Not yet", dot: "bg-[#ff453a]" },
  insufficient_evidence: { label: "Insufficient evidence", dot: "bg-[#8e8e93]" },
};

function scoreColor(score: number) {
  if (score >= 7.5) return "bg-[#30d158]";
  if (score >= 5) return "bg-[#ff9f0a]";
  return "bg-[#ff453a]";
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function FeedbackDashboard({ report, onRestart }: FeedbackDashboardProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const rec = RECOMMENDATION[report.recommendation];
  const stats = report.interviewStats;
  const assessed = report.competencyScores.filter((c) => c.score !== null).length;

  return (
    <div className="mx-auto max-w-5xl px-6 pb-32 pt-10 sm:px-10">
      <header className="flex items-center justify-between text-[15px] font-medium tracking-tight">
        <span>InterviewerAI</span>
        <span className="text-mute">Interview report</span>
      </header>

      <section className="pb-16 pt-16 sm:pt-24">
        <p
          className="animate-rise bg-gradient-to-b from-[#1d1d1f] to-[#b4b4b9] bg-clip-text font-semibold leading-[0.8] tracking-[-0.06em] text-transparent"
          style={{ fontSize: "clamp(9rem, 34vw, 26rem)" }}
        >
          {report.overallScore ?? "—"}
        </p>
        <p className="mt-8 text-2xl font-medium tracking-tight text-mute sm:text-[28px]">
          {report.overallScore === null
            ? "Not enough evidence to score."
            : `out of 100, weighted by role requirements.`}
        </p>
        <p className="mt-2 text-[15px] text-mute">
          {report.overallScore !== null && `${assessed} of ${report.competencyScores.length} competencies assessed · `}
          {stats.questionsAsked} questions · {stats.durationMinutes} of ~{stats.plannedMinutes} planned minutes
        </p>
      </section>

      <section className="border-t border-black/10 py-16">
        <p className="flex items-center gap-3 text-2xl font-semibold tracking-tight">
          <span className={`h-3 w-3 rounded-full ${rec.dot}`} />
          {rec.label}
          <span className="text-[17px] font-normal text-mute">{pct(report.confidence)} confidence</span>
        </p>
        <p className="mt-6 max-w-3xl text-2xl leading-[1.35] tracking-tight sm:text-[28px]">{report.summary}</p>
      </section>

      <section className="border-t border-black/10 py-16">
        <h2 className="mb-12 text-4xl font-semibold tracking-tight sm:text-5xl">Competencies.</h2>
        <div className="flex flex-col gap-10">
          {report.competencyScores.map((c) => (
            <div key={c.competency}>
              <div className="mb-3 flex items-baseline justify-between gap-4">
                <span className="text-xl font-semibold tracking-tight">
                  {c.competency} <span className="text-[15px] font-normal text-mute">· weight {pct(c.weight)}</span>
                </span>
                <span className="shrink-0 text-xl tabular-nums tracking-tight text-mute">
                  {c.score === null ? "Insufficient evidence" : `${c.score}/10`}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/10">
                {c.score !== null && <div className={`h-full rounded-full ${scoreColor(c.score)}`} style={{ width: `${c.score * 10}%` }} />}
              </div>
              {c.supportingQuotes.map((q) => (
                <p key={q} className="mt-3 text-[15px] italic text-mute">
                  “{q}”
                </p>
              ))}
              {c.concerns.map((q) => (
                <p key={q} className="mt-2 text-[15px] text-amber-700">
                  {q}
                </p>
              ))}
            </div>
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Findings title="Strengths." items={report.strengths} />
        <Findings title="Room to grow." items={report.weaknesses} />
      </div>

      <div className="mt-4 flex flex-col gap-4">
        <ListSection
          title="Not enough evidence."
          items={report.missingEvidence}
          footnote="Missing evidence is not a failure — these areas just weren't demonstrated in this interview."
        />
        <ListSection title="Resume claims checked." items={report.cvVerificationNotes} />
        <ListSection title="What to practise." items={report.recommendedPractice} />
      </div>

      <section className="pt-24">
        <h2 className="mb-8 text-4xl font-semibold tracking-tight sm:text-5xl">Question by question.</h2>
        <div className="divide-y divide-black/10 border-y border-black/10">
          {report.answerCritiques.map((c) => {
            const isOpen = expandedId === c.questionId;
            const improved = report.improvedAnswers.find((a) => a.questionId === c.questionId);
            return (
              <div key={c.questionId} className="py-6">
                <button
                  onClick={() => setExpandedId(isOpen ? null : c.questionId)}
                  aria-expanded={isOpen}
                  className="flex w-full items-center justify-between gap-6 text-left"
                >
                  <span className="text-xl font-semibold leading-snug tracking-tight">{c.question}</span>
                  <span className="flex shrink-0 items-center gap-3 text-[17px] tabular-nums text-mute">
                    {c.score !== null && `${c.score}/10`}
                    <ChevronDown className={`h-5 w-5 transition-transform ${isOpen ? "rotate-180" : ""}`} />
                  </span>
                </button>
                {isOpen && (
                  <div className="mt-6 flex flex-col gap-5 text-[17px]">
                    <p className="rounded-2xl bg-white p-5 leading-relaxed shadow-card">
                      <span className="font-semibold text-mute">Your answer: </span>
                      {c.answer}
                    </p>
                    <Bullets label="What worked" items={c.whatWorked} />
                    <Bullets label="What was missing" items={c.whatWasMissing} />
                    <Bullets label="Technical concerns" items={c.factualOrTechnicalConcerns} />
                    <Bullets label="A better structure" items={c.betterStructure} />
                    {improved && (
                      <div className="card !p-6">
                        <p className="mb-4 text-sm font-semibold text-accent">A stronger answer</p>
                        <Bullets label="Facts you stated" items={improved.factsStatedByCandidate} />
                        <Bullets label="Add these if true" items={improved.missingDetails} />
                        <p className="mt-4 whitespace-pre-line leading-relaxed">{improved.exampleAnswer}</p>
                        <p className="mt-4 text-sm text-mute">
                          [Bracketed] parts are placeholders — fill them with your real details, never invented ones.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {report.validationNotes.length > 0 && (
        <details className="mt-10 text-[15px] text-mute">
          <summary className="cursor-pointer font-medium">How this report was checked</summary>
          <ul className="mt-3 list-inside list-disc space-y-1.5">
            {report.validationNotes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>
      )}

      <div className="pt-24">
        <button onClick={onRestart} className="btn-primary !px-10 !py-5 !text-xl">
          <RotateCcw className="h-5 w-5" />
          Start another interview
        </button>
      </div>
    </div>
  );
}

function Findings({ title, items }: { title: string; items: EvidenceBasedFinding[] }) {
  return (
    <section className="card">
      <h2 className="mb-6 text-3xl font-semibold tracking-tight">{title}</h2>
      {items.length === 0 ? (
        <p className="text-[17px] text-mute">Nothing with enough evidence to report.</p>
      ) : (
        <ul className="space-y-6">
          {items.map((f) => (
            <li key={f.statement}>
              <p className="text-[17px] font-medium leading-snug">{f.statement}</p>
              <p className="mt-1.5 text-[15px] italic text-mute">{f.evidence}</p>
              <p className="mt-1 text-[15px] text-mute">{f.impactOnRole}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ListSection({ title, items, footnote }: { title: string; items: string[]; footnote?: string }) {
  if (items.length === 0) return null;
  return (
    <section className="card">
      <h2 className="mb-5 text-3xl font-semibold tracking-tight">{title}</h2>
      <ul className="list-inside list-disc space-y-2 text-[17px] leading-relaxed text-ink/80">
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
      {footnote && <p className="mt-5 text-sm text-mute">{footnote}</p>}
    </section>
  );
}

function Bullets({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="mb-1 text-sm font-semibold text-mute">{label}</p>
      <ul className="list-inside list-disc space-y-1 leading-relaxed text-ink/80">
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}
