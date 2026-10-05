import { GoogleGenAI, Type } from "@google/genai";
import type {
  ConversationTurn,
  EvaluationReport,
  InterviewerPersona,
} from "../types.js";

// Single shared client. The SDK reads nothing from the environment itself —
// we pass the key explicitly so a missing .env fails fast and loudly instead
// of silently calling Gemini unauthenticated.
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  throw new Error(
    "GEMINI_API_KEY is not set. Copy server/.env.example to server/.env and fill it in."
  );
}
const ai = new GoogleGenAI({ apiKey });

// "-latest" aliases track Google's current best model in each tier without
// us having to chase version-number churn (the dated gemini-3.x models hit
// transient 503 "high demand" errors frequently; this alias routes around
// that automatically). TTS uses a separate native Gemini audio model for
// real neural speech instead of the OS's robotic SpeechSynthesis voice.
const MODEL = "gemini-flash-latest";
const TTS_MODEL = "gemini-2.5-flash-preview-tts";

export interface RoleAnalysis {
  interviewerPersona: InterviewerPersona;
  keyCompetencies: string[];
  initialGreeting: string;
  seniorityLevel: string;
}

const roleAnalysisSchema = {
  type: Type.OBJECT,
  properties: {
    interviewerPersona: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING },
        title: { type: Type.STRING },
        tone: { type: Type.STRING },
      },
      required: ["name", "title", "tone"],
    },
    keyCompetencies: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    initialGreeting: { type: Type.STRING },
    seniorityLevel: {
      type: Type.STRING,
      description:
        "The seniority level this role is pitched at, inferred from the job description (e.g. 'Intern', 'Junior', 'Mid-level', 'Senior', 'Staff/Principal').",
    },
  },
  required: ["interviewerPersona", "keyCompetencies", "initialGreeting", "seniorityLevel"],
};

/** Phase 1: analyze the JD (+ optional resume) and build the interview's persona/rubric. */
export async function analyzeJobDescription(
  jobDescription: string,
  candidateResume?: string
): Promise<RoleAnalysis> {
  const prompt = `You are designing a mock job interview.

Job Description:
"""
${jobDescription}
"""

${candidateResume ? `Candidate Resume:\n"""\n${candidateResume}\n"""\n` : ""}
Analyze this role and produce:
- interviewerPersona: a realistic interviewer (name, title, tone/style of speaking) who would plausibly run this interview. Tone should be warm, encouraging, and conversational — never cold or intimidating.
- keyCompetencies: 4-5 core technical/behavioral skills this role should be evaluated on.
- initialGreeting: the exact opening line the interviewer speaks to welcome the candidate and kick off the call (1-2 sentences, warm but professional, spoken-language style).
- seniorityLevel: the seniority this role is actually pitched at (e.g. "Junior", "Mid-level", "Senior"), inferred from the job description's required years of experience and responsibilities. This will be used to keep interview questions appropriately scoped — do not infer a higher level than the JD actually supports.`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: roleAnalysisSchema,
    },
  });

  return JSON.parse(response.text ?? "{}") as RoleAnalysis;
}

/** Phase 2: given conversation history, produce the interviewer's next spoken line. */
export async function getNextInterviewerResponse(
  persona: InterviewerPersona,
  keyCompetencies: string[],
  seniorityLevel: string,
  history: ConversationTurn[]
): Promise<string> {
  const questionCount = history.filter((t) => t.role === "interviewer").length;

  const systemInstruction = `Act as ${persona.name}, ${persona.title}. Speaking tone: ${persona.tone} — warm, encouraging, and conversational. You are NOT trying to trip up or intimidate the candidate; you want to see them do their best, the way a good, fair interviewer does.

This interview is for a ${seniorityLevel} role. Evaluate the candidate against these competencies: ${keyCompetencies.join(
    ", "
  )}.

Difficulty calibration (important):
- Only ask questions that a reasonable ${seniorityLevel} candidate for this specific role could be expected to answer. Do not ask senior/staff-level or esoteric trivia questions for a junior/mid-level role.
- Every question must be clearly grounded in the job description and the competencies listed above — nothing tangential or random.
- It's fine to be thorough, but calibrate difficulty to the level, not maximum rigor.

Listen carefully to the candidate's most recent response before deciding what to say next:
- If the answer is unclear, too short, off-topic, or doesn't actually address the question, do NOT move on — ask a clarifying follow-up or gently rephrase the question so the candidate can try again.
- If the answer is substantive but could go deeper, probe it with a specific follow-up before moving to a new topic.
- Only advance to a brand-new question once the current one has been reasonably answered.
- React like a real human interviewer would: acknowledge what they said in a brief, natural way before asking the next thing, rather than jumping straight into a question.

Pacing (important): this is question/exchange number ${questionCount + 1} of what should be a full, substantial interview covering all ${keyCompetencies.length} competencies with real depth — aim for at least 8-10 interviewer questions total before the interview feels complete. Do NOT wrap up, say goodbye, or imply the interview is ending until the candidate explicitly says they're done or wants to end the call — keep the conversation going with new questions or follow-ups covering competencies not yet explored.

Keep your output concise (1-3 sentences) and phrased for natural spoken conversation — no markdown, no lists, no stage directions.`;

  const contents = history.map((turn) => ({
    role: turn.role === "interviewer" ? "model" : "user",
    parts: [{ text: turn.text }],
  }));

  const response = await ai.models.generateContent({
    model: MODEL,
    contents,
    config: {
      systemInstruction,
    },
  });

  return (response.text ?? "").trim();
}

// Gemini's native TTS endpoint returns raw 16-bit PCM (no container), which
// <audio>/decodeAudioData can't play directly — we prepend a standard WAV
// header so the client can just set it as an <audio> src.
function pcmToWavBase64(pcmBase64: string, sampleRate: number): string {
  const pcm = Buffer.from(pcmBase64, "base64");
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2; // 16-bit mono
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32); // block align (16-bit mono)
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]).toString("base64");
}

export interface SynthesizedSpeech {
  audioBase64: string;
  mimeType: "audio/wav";
}

/** Converts spoken text to natural-sounding audio using Gemini's native TTS. */
export async function synthesizeSpeech(
  text: string,
  voiceName = "Kore"
): Promise<SynthesizedSpeech | null> {
  if (!text.trim()) return null;

  try {
    const response = await ai.models.generateContent({
      model: TTS_MODEL,
      contents: text,
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName } },
        },
      },
    });

    const part = response.candidates?.[0]?.content?.parts?.[0];
    const inline = part?.inlineData;
    if (!inline?.data) return null;

    const rateMatch = /rate=(\d+)/.exec(inline.mimeType ?? "");
    const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;

    return {
      audioBase64: pcmToWavBase64(inline.data, sampleRate),
      mimeType: "audio/wav",
    };
  } catch (err) {
    console.error("[synthesizeSpeech] TTS failed, falling back to silent captions:", err);
    return null;
  }
}

const evaluationSchema = {
  type: Type.OBJECT,
  properties: {
    overallScore: { type: Type.NUMBER },
    hiringVerdict: {
      type: Type.OBJECT,
      properties: {
        recommendation: {
          type: Type.STRING,
          enum: ["Strong Hire", "Hire", "Leaning No Hire", "No Hire"],
        },
        confidencePercent: { type: Type.NUMBER },
        summary: { type: Type.STRING },
      },
      required: ["recommendation", "confidencePercent", "summary"],
    },
    competencyScores: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          score: { type: Type.NUMBER },
          note: { type: Type.STRING },
        },
        required: ["name", "score", "note"],
      },
    },
    strengths: { type: Type.ARRAY, items: { type: Type.STRING } },
    areasForImprovement: { type: Type.ARRAY, items: { type: Type.STRING } },
    detailedQandA: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          question: { type: Type.STRING },
          candidateAnswer: { type: Type.STRING },
          critique: { type: Type.STRING },
          suggestedBetterAnswer: { type: Type.STRING },
        },
        required: [
          "question",
          "candidateAnswer",
          "critique",
          "suggestedBetterAnswer",
        ],
      },
    },
  },
  required: [
    "overallScore",
    "hiringVerdict",
    "competencyScores",
    "strengths",
    "areasForImprovement",
    "detailedQandA",
  ],
};

/** Phase 4: score the full transcript against the rubric built in phase 1. */
export async function generateEvaluation(
  persona: InterviewerPersona,
  keyCompetencies: string[],
  seniorityLevel: string,
  history: ConversationTurn[]
): Promise<EvaluationReport> {
  const transcript = history
    .map((t) => `${t.role === "interviewer" ? persona.name : "Candidate"}: ${t.text}`)
    .join("\n");

  const prompt = `You are a fair, realistic hiring evaluator reviewing a completed interview transcript for a ${seniorityLevel} role.

Competencies to score (0-10 each): ${keyCompetencies.join(", ")}.

Calibrate every score and the hiring verdict against what is reasonable to expect from a ${seniorityLevel} candidate — do not penalize them for lacking senior-level depth they were never expected to have.

Transcript:
"""
${transcript}
"""

Produce a strict evaluation:
- overallScore: 0-100 holistic score.
- hiringVerdict: your honest read on whether this candidate would get hired for this role — recommendation (one of "Strong Hire", "Hire", "Leaning No Hire", "No Hire"), confidencePercent (0-100, how confident you are in that verdict), and summary (2-4 sentences explaining the verdict in plain language, referencing specific moments from the transcript).
- competencyScores: one entry per competency listed above, each with its name, a 0-10 score, and a brief note.
- strengths: notable strengths observed.
- areasForImprovement: concrete, actionable gaps.
- detailedQandA: for each interviewer question in the transcript, pair it with the candidate's answer, a short critique, and a suggested stronger answer.`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: evaluationSchema,
    },
  });

  return JSON.parse(response.text ?? "{}") as EvaluationReport;
}
