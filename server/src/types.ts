// Shared server-side types. Mirrors client/src/types.ts by convention —
// kept as a separate copy since client and server are independent packages.

export interface InitInterviewRequest {
  jobDescription: string;
  candidateResume?: string;
}

export interface InterviewerPersona {
  name: string;
  title: string;
  tone: string;
}

export interface InitInterviewResponse {
  rubricId: string;
  interviewerPersona: InterviewerPersona;
  keyCompetencies: string[];
  initialGreeting: string;
  seniorityLevel: string;
}

export interface ConversationTurn {
  role: "interviewer" | "candidate";
  text: string;
}

// Server-side session record. In-memory for the MVP; the shape is kept flat
// and serializable so it can be swapped for a Postgres/Supabase row later
// without touching the Gemini prompt-building code.
export interface InterviewSession {
  rubricId: string;
  jobDescription: string;
  candidateResume?: string;
  persona: InterviewerPersona;
  keyCompetencies: string[];
  seniorityLevel: string;
  history: ConversationTurn[];
  createdAt: number;
}

export interface CompetencyScore {
  name: string;
  score: number;
  note: string;
}

export interface QandA {
  question: string;
  candidateAnswer: string;
  critique: string;
  suggestedBetterAnswer: string;
}

export interface HiringVerdict {
  recommendation: "Strong Hire" | "Hire" | "Leaning No Hire" | "No Hire";
  confidencePercent: number;
  summary: string;
}

export interface EvaluationReport {
  overallScore: number;
  hiringVerdict: HiringVerdict;
  competencyScores: CompetencyScore[];
  strengths: string[];
  areasForImprovement: string[];
  detailedQandA: QandA[];
}
