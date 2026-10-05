# InterviewerAI

Paste a job description (and optional resume), talk to a lip-synced 3D avatar
interviewer in a live call room, and get a scored feedback report when you
end the call.

## Stack

- **Client**: React + Vite + TypeScript, Tailwind CSS, Lucide icons,
  `@met4citizen/talkinghead` for the 3D avatar, `socket.io-client`, and the
  browser's native Web Speech API for voice-to-text and TTS lip-sync.
- **Server**: Node + Express + TypeScript, `socket.io`, `@google/genai`
  (Gemini 2.5 Flash). Sessions live in an in-memory `Map` for the MVP.

## Setup

### 1. Server

```bash
cd server
cp .env.example .env     # then paste your Gemini API key into .env
npm install
npm run dev               # http://localhost:4000
```

`server/.env` is git-ignored — your `GEMINI_API_KEY` never gets committed.
Get a key from https://aistudio.google.com/apikey if you don't have one.

### 2. Client

```bash
cd client
npm install
npm run dev               # http://localhost:5173
```

Open http://localhost:5173, paste a job description, and launch the call
room. Voice input requires a Chromium-based browser (Chrome/Edge) for Web
Speech API support; other browsers fall back to captions-only interaction.

## Project layout

```
server/
  src/
    server.ts            Express app + Socket.io call loop
    services/gemini.ts    All Gemini prompts/schemas
    types.ts
client/
  src/
    App.tsx               View router: setup -> call -> feedback
    components/
      SetupForm.tsx        View A: JD/resume intake
      CallRoom.tsx          View B: live call room
      AvatarContainer.tsx   3D avatar (TalkingHead) wrapper
      FeedbackDashboard.tsx View C: scored report
    hooks/useSpeechRecognition.ts
```

## Before pushing to GitHub

`server/.env` is already in `.gitignore`. Double-check with
`git status` before your first commit that it isn't staged, and never commit
a real API key in `.env.example`.
