import { z } from "zod";
import type {
  AnalyzeRequest,
  FinishRequest,
  RespondRequest,
  TranscriptTurn,
} from "../../../shared/interviewTypes.js";
import { LIMITS } from "../config.js";
import {
  blueprintOutputSchema,
  candidateAnalysisOutputSchema,
  jobAnalysisOutputSchema,
} from "../services/gemini/geminiSchemas.js";

// Request-body validation. Each schema is checked against the shared API
// type so client and server can't drift apart silently.

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .optional()
    .transform((s) => (s?.trim() ? s.trim() : undefined));

export const analyzeRequestSchema = z.object({
  jobDescription: z
    .string({ error: "A job description is required." })
    .transform((s) => s.trim())
    .pipe(
      z
        .string()
        .min(
          LIMITS.minJobDescriptionCharacters,
          `Paste a fuller job description (at least ${LIMITS.minJobDescriptionCharacters} characters).`
        )
        .max(
          LIMITS.maxJobDescriptionCharacters,
          `The job description is too long (max ${LIMITS.maxJobDescriptionCharacters.toLocaleString()} characters).`
        )
    ),
  resumeText: z
    .string()
    .max(LIMITS.maxResumeCharacters, `The resume is too long (max ${LIMITS.maxResumeCharacters.toLocaleString()} characters).`)
    .optional()
    .transform((s) => (s?.trim() ? s.trim() : undefined)),
  targetRole: optionalText(120),
  companyName: optionalText(120),
  interviewMode: z.enum(["screening", "technical", "behavioral", "mixed"]).default("mixed"),
  preferredLength: z.enum(["short", "standard", "deep"]).default("standard"),
}) satisfies z.ZodType<AnalyzeRequest, unknown>;

const sessionId = z.string().min(8).max(64);

/** Client-supplied profiles are only used if the server lost the session; they are re-validated like model output. */
export const startRequestSchema = z.object({
  sessionId,
  jobProfile: jobAnalysisOutputSchema.optional(),
  candidateProfile: candidateAnalysisOutputSchema.extend({ hasResume: z.boolean() }).optional(),
  interviewBlueprint: blueprintOutputSchema.optional(),
});

export const respondRequestSchema = z.object({
  sessionId,
  turnId: z.number().int().min(1),
  questionId: z.string().min(1).max(64),
  questionText: z.string().max(1000).optional(),
  // Over-long answers are truncated, not rejected — the candidate already spoke.
  candidateTranscript: z.string().transform((s) => s.trim().slice(0, LIMITS.maxAnswerCharacters)),
  completionReason: z.enum(["manual", "silence", "timeout", "typed"]),
  elapsedSeconds: z.number().min(0).max(24 * 3600),
}) satisfies z.ZodType<RespondRequest, unknown>;

const transcriptTurnSchema = z.object({
  id: z.string().max(64),
  speaker: z.enum(["interviewer", "candidate"]),
  text: z.string().transform((s) => s.slice(0, LIMITS.maxAnswerCharacters)),
  questionId: z.string().max(64).optional(),
  timestamp: z.string().max(40),
  interrupted: z.boolean().optional(),
}) satisfies z.ZodType<TranscriptTurn, unknown>;

export const finishRequestSchema = z.object({
  sessionId,
  transcript: z.array(transcriptTurnSchema).max(LIMITS.maxQuestions * 6).default([]),
  retry: z.boolean().optional(),
}) satisfies z.ZodType<FinishRequest, unknown>;
