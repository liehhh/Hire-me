// API contract shared by the client and server. Type-only — no runtime
// code — so both packages can `import type` from here without bundling
// anything. The server's Zod schemas are checked against these types
// (see server/src/interview/inputSchemas.ts) so the two can't drift.

// ---------------------------------------------------------------------------
// Job + candidate analysis
// ---------------------------------------------------------------------------

export type JobFamily =
  | "frontend"
  | "backend"
  | "fullstack"
  | "mobile"
  | "data"
  | "devops"
  | "qa"
  | "security"
  | "product"
  | "design"
  | "finance"
  | "marketing"
  | "sales"
  | "operations"
  | "other";

export type Seniority = "intern" | "junior" | "mid" | "senior" | "lead" | "principal" | "unknown";

export type Importance = "critical" | "high" | "medium" | "low";

export type ExpectedDepth = "awareness" | "working" | "independent" | "advanced" | "expert" | "unknown";

export interface SkillRequirement {
  name: string;
  category: string;
  importance: Importance;
  /** Verbatim or near-verbatim phrase from the job description. */
  evidenceInJobDescription: string;
  expectedDepth: ExpectedDepth;
}

export type StageName =
  | "introduction"
  | "resume_walkthrough"
  | "role_motivation"
  | "technical_fundamentals"
  | "technical_deep_dive"
  | "coding"
  | "system_design"
  | "behavioral"
  | "situational"
  | "domain_specific"
  | "candidate_questions"
  | "closing";

export interface InterviewStage {
  name: StageName;
  purpose: string;
  estimatedMinutes: number;
  questionCount: number;
  competencies: string[];
  required: boolean;
}

export interface JobProfile {
  normalizedTitle: string;
  jobFamily: JobFamily;
  seniority: Seniority;
  coreResponsibilities: string[];
  requiredSkills: SkillRequirement[];
  preferredSkills: SkillRequirement[];
  toolsAndTechnologies: string[];
  businessContext: string[];
  likelyCompetencies: string[];
  likelyInterviewStages: InterviewStage[];
  estimatedInterviewDurationMinutes: number;
  /** 0..1 — how confident the analysis is, low for vague job descriptions. */
  confidence: number;
  /** Things the job description left ambiguous; never guessed. */
  uncertainties: string[];
}

export type EvidenceStatus = "explicitly_stated" | "partially_supported" | "unclear" | "not_present";

/** How a skill/technology appears on the CV — never proof of competence. */
export type UsageContext = "listed_only" | "project" | "professional" | "at_scale";

export interface SkillEvidence {
  skill: string;
  usageContext: UsageContext;
  evidenceStatus: EvidenceStatus;
  cvEvidence: string;
}

export interface ExperienceItem {
  role: string;
  organization: string;
  duration: string;
  summary: string;
  technologies: string[];
  evidenceStatus: EvidenceStatus;
}

export interface ProjectItem {
  name: string;
  description: string;
  technologies: string[];
  candidateRole: string;
  evidenceStatus: EvidenceStatus;
}

export interface CandidateProfile {
  hasResume: boolean;
  claimedSkills: string[];
  skillEvidence: SkillEvidence[];
  claimedExperience: ExperienceItem[];
  projects: ProjectItem[];
  measurableAchievements: string[];
  industries: string[];
  senioritySignals: string[];
  unclearClaims: string[];
  missingEvidenceForJobRequirements: string[];
}

export interface CompetencyWeight {
  competency: string;
  /** Relative weight; normalized server-side so all weights sum to 1. */
  weight: number;
  critical: boolean;
}

export interface DifficultyProfile {
  baseline: 1 | 2 | 3 | 4 | 5;
  maximum: 1 | 2 | 3 | 4 | 5;
  escalationRules: string[];
}

export interface CoverageRequirement {
  competency: string;
  minQuestions: number;
  mandatory: boolean;
  reason: string;
}

export interface InterviewBlueprint {
  totalQuestions: number;
  estimatedDurationMinutes: number;
  stages: InterviewStage[];
  competencyWeights: CompetencyWeight[];
  difficultyProfile: DifficultyProfile;
  requiredCoverage: CoverageRequirement[];
}

export type InterviewMode = "screening" | "technical" | "behavioral" | "mixed";
export type PreferredLength = "short" | "standard" | "deep";

// ---------------------------------------------------------------------------
// Live interview
// ---------------------------------------------------------------------------

export type QuestionSource =
  | "job_requirement"
  | "resume_claim"
  | "project"
  | "previous_answer"
  | "general_role_expectation";

export interface InterviewQuestion {
  id: string;
  text: string;
  stage: string;
  competency: string;
  difficulty: number;
  source: QuestionSource;
  sourceEvidence: string;
  expectedEvidence: string[];
  followUpTriggers: string[];
  maxFollowUps: number;
  /** True if this question probes the previous answer rather than opening a new topic. */
  isFollowUp: boolean;
}

export interface AnswerEvaluation {
  /** Dimension scores are 0..5. */
  relevance: number;
  specificity: number;
  /** null when the question had no technical content to judge. */
  technicalAccuracy: number | null;
  ownership: number;
  depth: number;
  structure: number;
  outcomeEvidence: number;
  /** 0..1 — confidence in this evaluation. */
  confidence: number;
  supportedClaims: string[];
  unsupportedClaims: string[];
  missingDetails: string[];
  contradictions: string[];
  evidenceSummary: string;
}

export type NextAction =
  | "ask_follow_up"
  | "move_to_next_competency"
  | "increase_difficulty"
  | "decrease_difficulty"
  | "clarify_claim"
  | "finish_stage";

export interface TranscriptTurn {
  id: string;
  speaker: "interviewer" | "candidate";
  text: string;
  questionId?: string;
  timestamp: string;
  interrupted?: boolean;
}

export interface InterviewProgress {
  currentStage: string;
  currentCompetency: string;
  questionsAsked: number;
  estimatedQuestionsRemaining: number;
  competenciesCovered: string[];
  elapsedMinutes: number;
  plannedMinutes: number;
}

export interface EvidenceLedgerItem {
  competency: string;
  evidenceFor: string[];
  evidenceAgainst: string[];
  unanswered: string[];
  /** 0..1 — how much interview evidence exists, not how good it was. */
  confidence: number;
  /** Candidate transcript turn ids the evidence came from. */
  transcriptReferences: string[];
}

export interface InterviewerPersona {
  name: string;
  title: string;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export type CompetencyEvidenceStatus = "strong" | "partial" | "weak" | "insufficient_evidence";

export interface CompetencyScore {
  competency: string;
  /** 0..10, or null when there was not enough interview evidence. */
  score: number | null;
  weight: number;
  evidenceStatus: CompetencyEvidenceStatus;
  supportingQuotes: string[];
  concerns: string[];
}

export interface EvidenceBasedFinding {
  statement: string;
  evidence: string;
  impactOnRole: string;
  confidence: number;
}

export interface AnswerCritique {
  questionId: string;
  question: string;
  answer: string;
  score: number | null;
  whatWorked: string[];
  whatWasMissing: string[];
  factualOrTechnicalConcerns: string[];
  betterStructure: string[];
  improvedAnswer?: string;
}

export interface ImprovedAnswer {
  questionId: string;
  question: string;
  /** Only facts present in the transcript or CV. */
  factsStatedByCandidate: string[];
  suggestedStructure: string[];
  /** Facts the candidate should add if true. */
  missingDetails: string[];
  /** Model answer using [placeholders] for anything not stated by the candidate. */
  exampleAnswer: string;
}

export type Recommendation = "strong_yes" | "yes" | "mixed" | "no" | "insufficient_evidence";

export interface InterviewReport {
  /** 0..100 weighted over competencies that have evidence, or null. */
  overallScore: number | null;
  recommendation: Recommendation;
  confidence: number;
  summary: string;
  competencyScores: CompetencyScore[];
  strengths: EvidenceBasedFinding[];
  weaknesses: EvidenceBasedFinding[];
  answerCritiques: AnswerCritique[];
  missingEvidence: string[];
  cvVerificationNotes: string[];
  recommendedPractice: string[];
  improvedAnswers: ImprovedAnswer[];
  /** What the server-side validation pass changed or flagged. */
  validationNotes: string[];
  interviewStats: {
    questionsAsked: number;
    durationMinutes: number;
    plannedMinutes: number;
    criticalCompetenciesCovered: string[];
    criticalCompetenciesMissed: string[];
  };
}

// ---------------------------------------------------------------------------
// HTTP contract
// ---------------------------------------------------------------------------

export interface AnalyzeRequest {
  jobDescription: string;
  resumeText?: string;
  targetRole?: string;
  companyName?: string;
  interviewMode?: InterviewMode;
  preferredLength?: PreferredLength;
}

export interface AnalyzeResponse {
  /** Server-side session prepared from this analysis. */
  sessionId: string;
  jobProfile: JobProfile;
  candidateProfile: CandidateProfile;
  interviewBlueprint: InterviewBlueprint;
}

export interface StartRequest {
  sessionId: string;
  jobProfile: JobProfile;
  candidateProfile: CandidateProfile;
  interviewBlueprint: InterviewBlueprint;
}

export interface StartResponse {
  sessionId: string;
  /** Turn 1 = the first question. Every answer is tied to exactly one turn. */
  turnId: number;
  persona: InterviewerPersona;
  firstQuestion: InterviewQuestion;
  openingText: string;
  progress: InterviewProgress;
}

export type AnswerCompletionReason = "manual" | "silence" | "timeout" | "typed";

export interface RespondRequest {
  sessionId: string;
  /** The turn the answer was captured in; (sessionId, turnId, questionId) is the idempotency key. */
  turnId: number;
  questionId: string;
  /** For logging/diagnostics only — the server uses its own copy of the question. */
  questionText?: string;
  /** The locked, final answer transcript. */
  candidateTranscript: string;
  completionReason: AnswerCompletionReason;
  elapsedSeconds: number;
}

export interface RespondResponse {
  /** Echo of the request's key, so the client can discard responses for other turns. */
  sessionId: string;
  turnId: number;
  questionId: string;
  /** The turn the next question opens, or null when the interview ended. */
  nextTurnId: number | null;
  /** One-sentence summary of the answer that was evaluated. */
  answerSummary: string;
  /** Null: the reply is sent as soon as it is ready; the evaluation finishes server-side afterwards. */
  answerEvaluation: AnswerEvaluation | null;
  nextAction: NextAction;
  nextQuestion?: InterviewQuestion;
  shouldContinue: boolean;
  /** Short text for Kokoro to speak: optional acknowledgement + question (or closing). */
  conversationMessage: string;
  progress: InterviewProgress;
}

export interface FinishRequest {
  sessionId: string;
  transcript: TranscriptTurn[];
  /** Must be true to regenerate a report after a previous failure. */
  retry?: boolean;
}

export interface FinishResponse {
  report: InterviewReport;
}

export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "SESSION_NOT_FOUND"
  | "SESSION_EXPIRED"
  | "SESSION_FINISHED"
  | "STALE_QUESTION"
  | "EMPTY_ANSWER"
  | "RATE_LIMITED"
  | "SESSION_LIMIT_REACHED"
  | "GEMINI_TIMEOUT"
  | "GEMINI_INVALID_OUTPUT"
  | "GEMINI_SAFETY_BLOCKED"
  | "GEMINI_EMPTY_RESPONSE"
  | "GEMINI_UNAVAILABLE"
  | "GEMINI_MODEL_UNAVAILABLE"
  | "GEMINI_AUTH"
  | "CANCELLED"
  | "INTERNAL_ERROR";

// --- POST /api/tts -----------------------------------------------------------
// Cloud speech for devices that can't run the on-device voice model (phones).

export interface TtsRequest {
  /** One sentence or short passage of plain text. */
  text: string;
}

export interface TtsResponse {
  /** Base64-encoded audio. */
  audio: string;
  /** e.g. "audio/mpeg" */
  mimeType: string;
  /** Characters billed for this request. */
  characters: number;
}

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    retryable: boolean;
    retryAfterSeconds?: number;
  };
}
