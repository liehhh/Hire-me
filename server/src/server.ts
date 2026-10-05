import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "socket.io";
import {
  analyzeJobDescription,
  generateEvaluation,
  getNextInterviewerResponse,
  synthesizeSpeech,
} from "./services/gemini.js";
import type { InitInterviewRequest, InterviewSession } from "./types.js";

const app = express();
const httpServer = createServer(app);

const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? "http://localhost:5173";

app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json({ limit: "2mb" }));

const io = new Server(httpServer, {
  cors: { origin: CLIENT_ORIGIN },
});

// In-memory session store for the MVP. Keyed by rubricId so it can be
// lifted into a `sessions` table (Postgres/Supabase) later by swapping
// this Map for a repository with the same get/set/delete shape.
const sessions = new Map<string, InterviewSession>();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/interview/init", async (req, res) => {
  try {
    const { jobDescription, candidateResume } = req.body as InitInterviewRequest;

    if (!jobDescription || jobDescription.trim().length < 20) {
      return res.status(400).json({ error: "jobDescription is required (min 20 chars)." });
    }

    const analysis = await analyzeJobDescription(jobDescription, candidateResume);
    const rubricId = randomUUID();

    sessions.set(rubricId, {
      rubricId,
      jobDescription,
      candidateResume,
      persona: analysis.interviewerPersona,
      keyCompetencies: analysis.keyCompetencies,
      seniorityLevel: analysis.seniorityLevel,
      history: [{ role: "interviewer", text: analysis.initialGreeting }],
      createdAt: Date.now(),
    });

    res.json({
      rubricId,
      interviewerPersona: analysis.interviewerPersona,
      keyCompetencies: analysis.keyCompetencies,
      initialGreeting: analysis.initialGreeting,
      seniorityLevel: analysis.seniorityLevel,
    });
  } catch (err) {
    console.error("[init] failed:", err);
    res.status(500).json({ error: "Failed to initialize interview." });
  }
});

app.post("/api/interview/evaluate", async (req, res) => {
  try {
    const { rubricId } = req.body as { rubricId: string };
    const session = sessions.get(rubricId);
    if (!session) {
      return res.status(404).json({ error: "Session not found." });
    }

    const report = await generateEvaluation(
      session.persona,
      session.keyCompetencies,
      session.seniorityLevel,
      session.history
    );

    res.json(report);
  } catch (err) {
    console.error("[evaluate] failed:", err);
    res.status(500).json({ error: "Failed to generate evaluation." });
  }
});

// --- Socket.io: live call loop -------------------------------------------
// Transcription happens client-side (browser Web Speech API) to avoid
// streaming raw audio to the server and burning free-tier audio tokens on
// Gemini; only finished text utterances travel over the socket.
io.on("connection", (socket) => {
  let activeRubricId: string | null = null;

  socket.on("start-interview", (rubricId: string) => {
    const session = sessions.get(rubricId);
    if (!session) {
      socket.emit("interview-error", { message: "Unknown session." });
      return;
    }
    activeRubricId = rubricId;
    socket.join(rubricId);
    // Replay the greeting generated during init so the avatar speaks it
    // once the call room has actually mounted and is listening.
    const greeting = session.history[0];
    synthesizeSpeech(greeting.text).then((audio) => {
      socket.emit("ai-response-spoken", { text: greeting.text, audio });
    });
  });

  socket.on("candidate-speech-transcript", async (payload: { text: string }) => {
    if (!activeRubricId) {
      socket.emit("interview-error", { message: "No active interview session." });
      return;
    }
    const session = sessions.get(activeRubricId);
    if (!session) {
      socket.emit("interview-error", { message: "Session expired." });
      return;
    }

    const candidateText = payload.text?.trim();
    if (!candidateText) return;

    session.history.push({ role: "candidate", text: candidateText });

    try {
      const aiText = await getNextInterviewerResponse(
        session.persona,
        session.keyCompetencies,
        session.seniorityLevel,
        session.history
      );
      session.history.push({ role: "interviewer", text: aiText });
      const audio = await synthesizeSpeech(aiText);
      socket.emit("ai-response-spoken", { text: aiText, audio });
    } catch (err) {
      console.error("[candidate-speech-transcript] failed:", err);
      socket.emit("interview-error", { message: "The interviewer failed to respond." });
    }
  });

  socket.on("disconnect", () => {
    activeRubricId = null;
  });
});

const PORT = Number(process.env.PORT ?? 4000);
httpServer.listen(PORT, () => {
  console.log(`InterviewerAI server listening on :${PORT}`);
});
