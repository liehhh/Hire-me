import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import type { InitInterviewResponse } from "../types";

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "http://localhost:4001";

interface SetupFormProps {
  onReady: (session: InitInterviewResponse) => void;
}

export function SetupForm({ onReady }: SetupFormProps) {
  const [jobDescription, setJobDescription] = useState("");
  const [resume, setResume] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (jobDescription.trim().length < 20) {
      setError("Paste a fuller job description (at least a couple sentences).");
      return;
    }

    setIsLoading(true);
    try {
      const res = await fetch(`${SERVER_URL}/api/interview/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobDescription,
          candidateResume: resume || undefined,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Server responded ${res.status}`);
      }

      const data = (await res.json()) as InitInterviewResponse;
      onReady(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col justify-center px-6 py-12">
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-bold text-white">InterviewerAI</h1>
        <p className="mt-2 text-slate-400">
          Paste a job description, optionally your resume, and practice with a live
          AI interviewer.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-300">
            Job Description
          </label>
          <textarea
            value={jobDescription}
            onChange={(e) => setJobDescription(e.target.value)}
            rows={8}
            placeholder="Paste the full job description here..."
            className="w-full rounded-lg border border-slate-700 bg-slate-900 p-3 text-sm text-slate-200 placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-slate-300">
            Your Resume <span className="text-slate-500">(optional)</span>
          </label>
          <textarea
            value={resume}
            onChange={(e) => setResume(e.target.value)}
            rows={5}
            placeholder="Paste your resume text here for more tailored questions..."
            className="w-full rounded-lg border border-slate-700 bg-slate-900 p-3 text-sm text-slate-200 placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
          />
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={isLoading}
          className="flex items-center justify-center gap-2 rounded-lg bg-emerald-600 py-3 font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isLoading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Preparing your interviewer...
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" />
              Launch Call Room
            </>
          )}
        </button>
      </form>
    </div>
  );
}
