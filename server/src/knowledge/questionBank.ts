import { z } from "zod";
import type { JobProfile } from "../../../shared/interviewTypes.js";
import bankJson from "../../RAG/InterviewerAI_RAG_Starter_Bank.json" with { type: "json" };
import type { RubricSource } from "./rubric.js";

// The role-specific question bank (server/RAG). Retrieval is plain code over
// the entries' metadata: the bank is small enough that filtering and scoring
// in memory is instant and needs no embeddings call, vector store or network.
// Retrieved entries are reference material for the interviewer; the answer
// criteria never reach the browser.

const entrySchema = z.object({
  id: z.string().min(1),
  version: z.number().int(),
  roles: z.array(z.string()),
  domain: z.string(),
  competency: z.string(),
  level: z.string(),
  language: z.string(),
  question: z.string().min(5),
  expected_answer_summary: z.string(),
  criteria: z
    .array(z.object({ id: z.string().min(1), description: z.string(), max_points: z.number().positive() }))
    .min(1),
  common_misconceptions: z.array(z.string()),
  follow_up_questions: z.array(z.string()),
  review_status: z.string(),
});

export type BankEntry = z.output<typeof entrySchema>;

/** Entries that fail validation are dropped (and logged) rather than breaking interviews. */
export function loadBank(raw: unknown): BankEntry[] {
  const entries: BankEntry[] = [];
  const parsed = z.object({ entries: z.array(z.unknown()) }).safeParse(raw);
  if (!parsed.success) {
    console.error("[bank] question bank is not in the expected format; running without it");
    return entries;
  }
  const ids = new Set<string>();
  for (const candidate of parsed.data.entries) {
    const entry = entrySchema.safeParse(candidate);
    if (!entry.success || ids.has(entry.data.id)) {
      console.error(`[bank] skipping an invalid or duplicate entry (${(candidate as { id?: unknown })?.id ?? "no id"})`);
      continue;
    }
    ids.add(entry.data.id);
    entries.push(entry.data);
  }
  return entries;
}

const BANK: BankEntry[] = loadBank(bankJson);

export function bankEntry(id: string, bank: BankEntry[] = BANK): BankEntry | undefined {
  return bank.find((e) => e.id === id);
}

export const sourceOf = (entry: BankEntry): RubricSource => ({
  id: entry.id,
  version: entry.version,
  reviewStatus: entry.review_status,
});

// --- retrieval ------------------------------------------------------------------

/** Words in a job description that point at each bank domain. */
const DOMAIN_KEYWORDS: Record<string, string[]> = {
  javascript: ["javascript", "ecmascript", "js", "react", "vue", "angular", "node"],
  typescript: ["typescript", "ts"],
  nodejs: ["node", "nodejs", "node.js", "express", "nestjs", "fastify", "deno"],
  apis: ["api", "apis", "rest", "restful", "graphql", "grpc", "http", "microservice", "microservices", "webhook"],
  postgresql: ["postgres", "postgresql", "sql", "database", "databases", "mysql", "rdbms", "orm"],
  "ai-engineering": [
    "llm",
    "llms",
    "rag",
    "retrieval",
    "embedding",
    "embeddings",
    "vector",
    "prompt",
    "openai",
    "gemini",
    "anthropic",
    "langchain",
    "ai",
    "generative",
    "agent",
    "agents",
  ],
};

const FAMILY_ROLES: Record<string, string[]> = {
  backend: ["backend-developer", "full-stack-developer"],
  fullstack: ["full-stack-developer", "backend-developer"],
  frontend: ["full-stack-developer"],
};

const words = (text: string) => text.toLowerCase().match(/[a-z0-9.+#]+/g) ?? [];

/** Bank questions are written at "intermediate" or "advanced"; level is difficulty, not a job-title match. */
function preferredLevel(seniority: JobProfile["seniority"]): string | undefined {
  if (seniority === "senior" || seniority === "lead" || seniority === "principal") return "advanced";
  if (seniority === "intern" || seniority === "junior" || seniority === "mid") return "intermediate";
  return undefined;
}

export interface RetrievalInput {
  job: JobProfile;
  /** All blueprint competency names. */
  competencies: string[];
  /** Competencies that still need evidence; matches here rank higher. */
  priorityCompetencies: string[];
  /** Bank entries already asked in this interview. */
  excludeIds: string[];
  k?: number;
}

export interface RetrievedEntry {
  entry: BankEntry;
  score: number;
}

/**
 * Picks the bank entries worth offering the interviewer for the next question.
 * An entry must match the job's technology; role, level and the interview's
 * competencies then rank the matches. Returns nothing for jobs the bank does
 * not cover (it only has developer roles).
 */
export function retrieveEntries(input: RetrievalInput, bank: BankEntry[] = BANK): RetrievedEntry[] {
  const { job } = input;
  const skillWords = new Set(
    words([...job.requiredSkills.map((s) => s.name), ...job.preferredSkills.map((s) => s.name)].join(" "))
  );
  const otherWords = new Set(
    words([job.normalizedTitle, ...job.toolsAndTechnologies, ...job.coreResponsibilities].join(" "))
  );
  const roles = FAMILY_ROLES[job.jobFamily] ?? [];
  const level = preferredLevel(job.seniority);
  const priority = new Set(input.priorityCompetencies.flatMap((c) => words(c)));
  const wanted = new Set(input.competencies.flatMap((c) => words(c)));
  const exclude = new Set(input.excludeIds);

  const scored: RetrievedEntry[] = [];
  for (const entry of bank) {
    if (exclude.has(entry.id) || entry.language !== "en") continue;

    // The job must mention the entry's technology; a required skill counts double.
    const keywords = DOMAIN_KEYWORDS[entry.domain] ?? [];
    let domainScore = 0;
    for (const k of keywords) {
      if (skillWords.has(k)) domainScore += 2;
      else if (otherWords.has(k)) domainScore += 1;
    }
    if (domainScore === 0) continue;

    let score = Math.min(domainScore, 6);
    if (entry.roles.some((r) => roles.includes(r))) score += 1;
    if (level && entry.level === level) score += 1;
    const competencyWords = words(entry.competency).filter((w) => w.length >= 4);
    if (competencyWords.some((w) => priority.has(w))) score += 2;
    else if (competencyWords.some((w) => wanted.has(w))) score += 1;
    scored.push({ entry, score });
  }

  return scored.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id)).slice(0, input.k ?? 3);
}
