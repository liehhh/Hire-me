# InterviewerAI

Paste a job description (and optionally your resume). You get an interview
planned for that exact role and seniority, held by a lip-synced 3D avatar,
followed by a report based only on what you actually said.

```text
Next.js (React) ──HTTP──▶ Node/Express ──▶ Gemini (server-side only)
   │
   └─ voice: Deepgram Aura via /api/tts ──▶ TalkingHead avatar lip-sync
```

## Setup

### 1. Server

```bash
cd server
cp .env.example .env     # paste your GEMINI_API_KEY and set GEMINI_MODEL
npm install
npm run dev               # http://localhost:4001
```

`GEMINI_MODEL` must be a model your key can generate with. Older models such
as `gemini-2.5-flash` return 404 for newly created keys; the server sends one
1-token request at startup and exits with a clear message if the model is
unavailable (disable with `GEMINI_STARTUP_CHECK=false`). Get a key at
https://aistudio.google.com/apikey.

### 2. Client

```bash
cd client
npm install
npm run dev               # Next.js on http://localhost:5173
```

Voice input uses the Web Speech API (Chrome/Edge) with an on-device Whisper
fallback; you can also type answers.

The interviewer's voice is Deepgram Aura, synthesized by the server through
`POST /api/tts` one sentence at a time and decoded in the browser, so it sounds
the same on every device and nothing is downloaded. (An on-device model was
tried first; its WASM/WebGPU runtime terminates the page on iOS Safari.) The
API key lives in SSM Parameter Store (`DeepgramApiKeyParameter` in
`template.yaml`) or, locally, in `DEEPGRAM_API_KEY`; `TTS_CHARS_PER_DAY` caps
what a deployment can spend. If the voice service is unavailable or its budget
is used up, the browser's built-in voice takes over so the interview continues.

### Tests

```bash
cd server && npm test      # Gemini client, flow rules, report validation
cd client && npm test      # Speech pipeline, conversation state machine
```

## API

| Route | Purpose |
| --- | --- |
| `POST /api/interview/analyze` | Job profile, CV profile, interview blueprint (2–3 Gemini calls) |
| `POST /api/interview/start` | Opening line + first question (1 call, idempotent) |
| `POST /api/interview/respond` | Evaluate the final answer + next question (1 call, idempotent per answer) |
| `POST /api/interview/finish` | Validated report (1 call; never regenerated without `retry: true`) |

Request/response types live in `shared/interviewTypes.ts` and are used by both
packages.

## Project layout

```
shared/interviewTypes.ts        API contract (types only)
server/src/
  server.ts                     Express app, startup model check
  config.ts                     Env + hard limits (LIMITS)
  routes/interview.ts           Routes + error mapping
  interview/
    interviewService.ts         analyze / start / respond / finish orchestration
    flow.ts                     Pacing rules, follow-up caps, evidence ledger
    blueprint.ts                Duration/difficulty/weight normalisation
    report.ts                   Report validation pass (quotes, scores, placeholders)
    session.ts                  In-memory session store with TTL
    inputSchemas.ts             Request validation (Zod)
  services/
    rateLimiter.ts              Global Gemini budget + per-IP HTTP limit
    gemini/                     Client, prompts, Zod schemas, error mapping
client/src/
  App.tsx                       setup → plan → call → report
  api/interviewApi.ts           Typed backend client
  components/                   SetupForm, InterviewPrep, CallRoom, FeedbackDashboard
  features/tts/                 Speech (cloud client, playback, visemes)
  features/avatar/              Avatar lip-sync adapter
```

## Before pushing to GitHub

`server/.env` is git-ignored. Check `git status` before committing and never
put a real API key in `.env.example`.

## Deploying to AWS (Amplify + Lambda + DynamoDB)

```
Browser ─▶ Amplify Hosting (Next.js client)
   │
   └─HTTPS─▶ Lambda Function URL ─▶ Gemini
                  ├─▶ DynamoDB   (sessions + rate-limit counters, TTL)
                  └─▶ SSM Parameter Store (Gemini API key)
```

Locally nothing changes (Express server + in-memory sessions). In AWS each
request runs on whichever Lambda instance is free, so `server/src/lambda/app.ts`
loads the session from DynamoDB, runs the same `InterviewService`, and saves it
back (optimistic locking, items expire via TTL). The Function URL has no
30-second cap, so the ~1 minute report in `/finish` works as-is.

**One-time setup** (needs the AWS CLI and SAM CLI, signed in to your account):

```bash
# 1. Budget alert first: AWS console > Billing > Budgets > e.g. $5/month.

# 2. Store the Gemini key (SecureString on the default key is free).
aws ssm put-parameter --name /interviewerai/gemini-api-key --type SecureString --value "<your key>"

# 3. Build and deploy the backend.
cd server && npm run build:lambda && cd ..
sam deploy --guided        # accept defaults; note the ApiUrl output
```

Then in the Amplify console: *Host web app* > connect this repo > Amplify
detects `amplify.yml` (app root `client`). Add the environment variable
`NEXT_PUBLIC_SERVER_URL` = the `ApiUrl` output **without the trailing slash**,
and deploy. Finally re-run `sam deploy` with `ClientOrigin` set to your Amplify
URL (e.g. `https://main.abc123.amplifyapp.com`) so the browser is allowed to call the API.

Cost guards: `GeminiCallsPerDay` (default 300) caps the whole deployment's
Gemini usage per day, the per-IP limit still applies, and DynamoDB runs on 5/5
provisioned capacity, which is inside the always-free tier.
