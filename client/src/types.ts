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
