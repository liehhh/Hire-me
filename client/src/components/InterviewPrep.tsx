"use client";

import { AlertTriangle, ArrowLeft, Mic } from "lucide-react";
import { unlockAudio } from "../features/tts/audioPlayback";
import type { AnalyzeResponse } from "../types";

interface InterviewPrepProps {
  analysis: AnalyzeResponse;
  onStart: () => void;
  onBack: () => void;
}

export const humanize = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export function InterviewPrep({ analysis, onStart, onBack }: InterviewPrepProps) {
  const { jobProfile: job, candidateProfile: cv, interviewBlueprint: plan } = analysis;

  const handleStart = () => {
    // Create/resume the interviewer's AudioContext inside this click so
    // browser autoplay policies allow the local Kokoro voice to play later.
    void unlockAudio();
    onStart();
  };

  return (
    <div className="mx-auto max-w-5xl px-6 pb-32 pt-10 sm:px-10">
      <button onClick={onBack} className="flex items-center gap-1.5 text-[15px] font-medium text-accent hover:underline">
        <ArrowLeft className="h-4 w-4" /> Edit inputs
      </button>

      <section className="pb-20 pt-20 sm:pt-28">
        <p className="eyebrow animate-rise">
          {humanize(job.seniority)} · {humanize(job.jobFamily)}
        </p>
        <h1 className="display animate-rise mt-4 !text-[clamp(3rem,9vw,8rem)] [animation-delay:80ms]">{job.normalizedTitle}</h1>
      </section>

      <div className="grid grid-cols-1 gap-y-10 border-y border-black/10 py-14 sm:grid-cols-3">
        <Stat value={`~${plan.estimatedDurationMinutes}`} unit="min" label="Duration" />
        <Stat value={`~${plan.totalQuestions}`} unit="" label="Questions" />
        <Stat value={`${plan.difficultyProfile.baseline}–${plan.difficultyProfile.maximum}`} unit="/ 5" label="Difficulty" />
      </div>

      <section className="py-20">
        <h2 className="mb-10 text-4xl font-semibold tracking-tight sm:text-5xl">How it unfolds.</h2>
        <ol className="divide-y divide-black/10">
          {plan.stages.map((s, i) => (
            <li
              key={s.name}
              className="grid grid-cols-[2.5rem_1fr_auto] items-baseline gap-x-4 gap-y-1 py-5 sm:grid-cols-[3rem_14rem_1fr_auto]"
            >
              <span className="text-[15px] tabular-nums text-mute">{String(i + 1).padStart(2, "0")}</span>
              <span className="text-xl font-semibold tracking-tight">{humanize(s.name)}</span>
              <span className="col-start-2 text-[17px] leading-snug text-mute sm:col-start-auto">{s.purpose}</span>
              <span className="col-start-3 row-start-1 text-[15px] tabular-nums text-mute sm:col-start-auto sm:row-start-auto">
                ~{s.estimatedMinutes} min
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section className="pb-20">
        <h2 className="mb-10 text-4xl font-semibold tracking-tight sm:text-5xl">What's assessed.</h2>
        <div className="flex flex-col gap-5">
          {plan.competencyWeights.map((c) => (
            <div key={c.competency} className="flex items-center gap-5">
              <span className="flex-1 text-lg tracking-tight">
                {c.competency}
                {c.critical && (
                  <span className="ml-3 rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-medium text-amber-700">critical</span>
                )}
              </span>
              <div className="hidden h-1 w-48 overflow-hidden rounded-full bg-black/10 sm:block">
                <div className="h-full rounded-full bg-ink" style={{ width: `${Math.round(c.weight * 100)}%` }} />
              </div>
              <span className="w-12 text-right text-[15px] tabular-nums text-mute">{Math.round(c.weight * 100)}%</span>
            </div>
          ))}
        </div>
      </section>

      {(job.uncertainties.length > 0 || cv.missingEvidenceForJobRequirements.length > 0) && (
        <section className="card mb-20 text-[17px]">
          {job.uncertainties.length > 0 && (
            <>
              <h2 className="mb-3 flex items-center gap-2 text-xl font-semibold tracking-tight">
                <AlertTriangle className="h-5 w-5 text-amber-500" /> The job description doesn't specify
              </h2>
              <ul className="mb-8 list-inside list-disc space-y-1.5 text-mute">
                {job.uncertainties.map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
            </>
          )}
          {cv.missingEvidenceForJobRequirements.length > 0 && (
            <>
              <h2 className="mb-3 text-xl font-semibold tracking-tight">Requirements your resume doesn't show evidence for</h2>
              <ul className="list-inside list-disc space-y-1.5 text-mute">
                {cv.missingEvidenceForJobRequirements.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      <div className="flex flex-col items-start gap-8">
        <p className="max-w-2xl text-xl leading-snug tracking-tight text-mute">
          The interviewer speaks first; your microphone opens only when it has finished. Answer out loud for as long as
          you need, then click “Done speaking” — a long silence also ends your answer. End the interview any time to get
          your report.
        </p>
        <button onClick={handleStart} className="btn-primary !px-10 !py-5 !text-xl">
          <Mic className="h-5 w-5" /> Start interview
        </button>
      </div>
    </div>
  );
}

function Stat({ value, unit, label }: { value: string; unit: string; label: string }) {
  return (
    <div>
      <p className="text-[clamp(4rem,9vw,7.5rem)] font-semibold leading-none tracking-[-0.05em]">
        {value}
        {unit && <span className="ml-2 text-[0.3em] font-medium tracking-tight text-mute">{unit}</span>}
      </p>
      <p className="mt-3 text-[15px] font-medium text-mute">{label}</p>
    </div>
  );
}
