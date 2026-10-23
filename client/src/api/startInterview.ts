import type { AnalyzeResponse, StartResponse } from "../types";
import { interviewApi } from "./interviewApi";

// The first question only depends on the analysis, so it is requested as soon
// as the analysis arrives. The Start click then finds it ready (or joins the
// request still running) instead of starting a Gemini call of its own.

const prefetched = new Map<string, Promise<StartResponse>>();

const request = (analysis: AnalyzeResponse) =>
  interviewApi.start({
    sessionId: analysis.sessionId,
    jobProfile: analysis.jobProfile,
    candidateProfile: analysis.candidateProfile,
    interviewBlueprint: analysis.interviewBlueprint,
  });

/** Fire-and-forget: errors surface later, when the interview actually starts. */
export function prefetchStart(analysis: AnalyzeResponse): void {
  if (prefetched.has(analysis.sessionId)) return;
  const promise = request(analysis);
  prefetched.set(analysis.sessionId, promise);
  promise.catch(() => {
    if (prefetched.get(analysis.sessionId) === promise) prefetched.delete(analysis.sessionId);
  });
}

/** Uses the prefetched first question once; any retry asks the server again (it replays the saved one). */
export function startInterview(analysis: AnalyzeResponse): Promise<StartResponse> {
  const ready = prefetched.get(analysis.sessionId);
  prefetched.delete(analysis.sessionId);
  return ready ?? request(analysis);
}
