"use client";

import { useRef, useState } from "react";
import { ArrowRight, FileUp, Loader2 } from "lucide-react";
import { interviewApi, ApiRequestError } from "../api/interviewApi";
import { prefetchStart } from "../api/startInterview";
import type { AnalyzeRequest, AnalyzeResponse, InterviewMode, PreferredLength } from "../types";

const MIN_JD_CHARS = 50;
const MAX_TEXT_CHARS = 30_000;

const MODES: { value: InterviewMode; label: string; hint: string }[] = [
  { value: "mixed", label: "Mixed", hint: "Technical + behavioral, like a full loop" },
  { value: "technical", label: "Technical", hint: "Skills, depth and trade-offs" },
  { value: "behavioral", label: "Behavioral", hint: "Ownership, collaboration, judgment" },
  { value: "screening", label: "Screening", hint: "Recruiter-style fit and motivation" },
];

const LENGTHS: { value: PreferredLength; label: string }[] = [
  { value: "short", label: "Short" },
  { value: "standard", label: "Standard" },
  { value: "deep", label: "Deep" },
];

interface SetupFormProps {
  onAnalyzed: (analysis: AnalyzeResponse) => void;
}

export function SetupForm({ onAnalyzed }: SetupFormProps) {
  const [jobDescription, setJobDescription] = useState("");
  const [resume, setResume] = useState("");
  const [targetRole, setTargetRole] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [interviewMode, setInterviewMode] = useState<InterviewMode>("mixed");
  const [preferredLength, setPreferredLength] = useState<PreferredLength>("standard");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Guards against double submission (double click / Enter mashing).
  const inFlightRef = useRef(false);

  const handleResumeFile = async (file: File | undefined) => {
    if (!file) return;
    if (!/\.(txt|md|text)$/i.test(file.name) && !file.type.startsWith("text/")) {
      setError("Upload a plain-text resume (.txt or .md), or paste its text below.");
      return;
    }
    const text = await file.text();
    setResume(text.slice(0, MAX_TEXT_CHARS));
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (inFlightRef.current) return;
    setError(null);

    if (jobDescription.trim().length < MIN_JD_CHARS) {
      setError("Paste the full job description — responsibilities and requirements — so the interview can be tailored.");
      return;
    }

    const body: AnalyzeRequest = {
      jobDescription,
      resumeText: resume.trim() || undefined,
      targetRole: targetRole.trim() || undefined,
      companyName: companyName.trim() || undefined,
      interviewMode,
      preferredLength,
    };

    inFlightRef.current = true;
    setIsLoading(true);
    try {
      const analysis = await interviewApi.analyze(body);
      // Generate the first question while the candidate is still on the prep screen.
      prefetchStart(analysis);
      onAnalyzed(analysis);
    } catch (err) {
      const message = err instanceof ApiRequestError ? err.message : "Something went wrong.";
      const wait =
        err instanceof ApiRequestError && err.retryAfterSeconds
          ? ` (try again in about ${Math.ceil(err.retryAfterSeconds / 60) > 1 ? `${Math.ceil(err.retryAfterSeconds / 60)} minutes` : `${err.retryAfterSeconds} seconds`})`
          : "";
      setError(message + wait);
    } finally {
      inFlightRef.current = false;
      setIsLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-6 pb-32 pt-10 sm:px-10">
      <header className="flex items-center justify-between text-[15px] font-medium tracking-tight">
        <span>InterviewerAI</span>
        <span className="text-mute">Interview practice</span>
      </header>

      <section className="pb-24 pt-24 sm:pt-36">
        <h1 className="display animate-rise">
          Practice
          <br />
          <span className="bg-gradient-to-b from-[#1d1d1f] to-[#9a9aa0] bg-clip-text text-transparent">the real thing.</span>
        </h1>
        <p className="animate-rise mt-10 max-w-2xl text-2xl font-medium leading-snug tracking-tight text-mute [animation-delay:120ms] sm:text-[28px]">
          An interview planned for the exact role. A report built only from what you actually said.
        </p>
      </section>

      <form onSubmit={handleSubmit} className="flex flex-col gap-16">
        <div>
          <label htmlFor="jd" className="mb-4 block text-3xl font-semibold tracking-tight">
            The role.
          </label>
          <textarea
            id="jd"
            value={jobDescription}
            onChange={(e) => setJobDescription(e.target.value)}
            maxLength={MAX_TEXT_CHARS}
            rows={9}
            placeholder="Paste the full job description…"
            className="field resize-y"
          />
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="role" className="mb-2 block px-1 text-sm font-medium text-mute">
                Target role
              </label>
              <input
                id="role"
                value={targetRole}
                onChange={(e) => setTargetRole(e.target.value)}
                maxLength={120}
                placeholder="Senior Backend Engineer"
                className="field"
              />
            </div>
            <div>
              <label htmlFor="company" className="mb-2 block px-1 text-sm font-medium text-mute">
                Company
              </label>
              <input
                id="company"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                maxLength={120}
                placeholder="Acme"
                className="field"
              />
            </div>
          </div>
        </div>

        <div>
          <div className="mb-4 flex items-baseline justify-between gap-4">
            <label htmlFor="resume" className="text-3xl font-semibold tracking-tight">
              You. <span className="font-normal text-mute">Optional.</span>
            </label>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1.5 text-[15px] font-medium text-accent hover:underline"
            >
              <FileUp className="h-4 w-4" /> Upload .txt / .md
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.md,.text,text/plain,text/markdown"
              className="hidden"
              onChange={(e) => void handleResumeFile(e.target.files?.[0])}
            />
          </div>
          <textarea
            id="resume"
            value={resume}
            onChange={(e) => setResume(e.target.value)}
            maxLength={MAX_TEXT_CHARS}
            rows={6}
            placeholder="Paste your resume for questions about your own experience…"
            className="field resize-y"
          />
        </div>

        <fieldset>
          <legend className="mb-4 text-3xl font-semibold tracking-tight">The format.</legend>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {MODES.map((m) => {
              const active = interviewMode === m.value;
              return (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => setInterviewMode(m.value)}
                  aria-pressed={active}
                  className={`rounded-3xl p-5 text-left shadow-card transition ${
                    active ? "bg-ink text-white" : "bg-white text-ink hover:bg-white/60"
                  }`}
                >
                  <span className="block text-lg font-semibold tracking-tight">{m.label}</span>
                  <span className={`mt-1 block text-sm leading-snug ${active ? "text-white/60" : "text-mute"}`}>{m.hint}</span>
                </button>
              );
            })}
          </div>

          <div className="mt-6 inline-flex rounded-full bg-black/[0.06] p-1">
            {LENGTHS.map((l) => (
              <button
                key={l.value}
                type="button"
                onClick={() => setPreferredLength(l.value)}
                aria-pressed={preferredLength === l.value}
                className={`rounded-full px-6 py-2 text-[15px] font-medium transition ${
                  preferredLength === l.value ? "bg-white text-ink shadow-card" : "text-mute hover:text-ink"
                }`}
              >
                {l.label}
              </button>
            ))}
          </div>
          <p className="mt-3 px-1 text-sm text-mute">Actual duration is set by the role's seniority, like a real interview.</p>
        </fieldset>

        {error && (
          <p role="alert" className="text-[17px] text-red-600">
            {error}
          </p>
        )}

        <div>
          <button type="submit" disabled={isLoading} className="btn-primary !px-10 !py-5 !text-xl">
            {isLoading ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" />
                Planning your interview…
              </>
            ) : (
              <>
                Plan my interview <ArrowRight className="h-5 w-5" />
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
