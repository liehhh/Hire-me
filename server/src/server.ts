import express from "express";
import cors from "cors";
import { config, LIMITS } from "./config.js";
import { InterviewService } from "./interview/interviewService.js";
import { SessionStore } from "./interview/session.js";
import { errorHandler, interviewRouter } from "./routes/interview.js";
import { generateStructured, verifyGeminiModel } from "./services/gemini/geminiClient.js";
import { ipRateLimit } from "./services/rateLimiter.js";
import { createPollySynthesizer, speak } from "./services/tts/ttsService.js";

// React -> this server -> Gemini. The browser never sees the Gemini key or
// prompts; it only receives validated, structured results.

let modelStatus: "unchecked" | "ok" | "unavailable" = "unchecked";
let modelStatusMessage = "";

async function main() {
  if (!config.geminiApiKey) {
    console.error("\n[config] GEMINI_API_KEY is not set. Copy server/.env.example to server/.env and fill it in.\n");
    process.exit(1);
  }

  if (config.geminiStartupCheck) {
    const result = await verifyGeminiModel();
    if (result.ok) {
      modelStatus = "ok";
      console.log(`[gemini] model "${config.geminiModel}" is available.`);
    } else if (result.fatal) {
      console.error(`\n[config] ${result.message}\n`);
      process.exit(1);
    } else {
      // Rate limit or network blip: start anyway, requests will surface it.
      modelStatus = "unavailable";
      modelStatusMessage = result.message;
      console.warn(`[gemini] startup check for "${config.geminiModel}" did not succeed: ${result.message}`);
    }
  }

  const app = express();
  app.set("trust proxy", "loopback");
  app.use(cors({ origin: config.clientOrigin }));
  app.use(express.json({ limit: "512kb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, model: config.geminiModel, modelStatus, modelStatusMessage });
  });

  const store = new SessionStore();
  store.startSweeper();
  const service = new InterviewService(generateStructured, store);

  app.use("/api/interview", ipRateLimit(LIMITS.httpRequestsPerMinutePerIp), interviewRouter(service));
  // Cloud voice (needs AWS credentials locally).
  if (config.ttsEnabled) {
    const synthesize = createPollySynthesizer({ voice: config.pollyVoice, engine: config.pollyEngine });
    app.post("/api/tts", ipRateLimit(LIMITS.httpRequestsPerMinutePerIp), (req, res, next) => {
      speak(synthesize, req.body)
        .then((body) => res.json(body))
        .catch(next);
    });
  }
  app.use(errorHandler);

  app.listen(config.port, () => {
    console.log(`InterviewerAI server listening on :${config.port} (Gemini model: ${config.geminiModel})`);
  });
}

void main();
