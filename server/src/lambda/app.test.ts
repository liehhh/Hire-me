import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import { InterviewService } from "../interview/interviewService.js";
import { SessionStore } from "../interview/session.js";
import {
  blueprintOutput,
  fakeGenerate,
  jobOutput,
  liveTurnEvalOutput,
  liveTurnOutput,
  questionDraft,
  reportOutput,
} from "../interview/testFixtures.js";
import { DynamoStore, type DocClient } from "../persistence/dynamoStore.js";
import { createLambdaApp, type UrlEvent } from "./app.js";

/** Minimal in-memory stand-in for the DynamoDB document client (Get / Put with condition / Update-ADD). */
function fakeDynamo() {
  const items = new Map<string, Record<string, unknown>>();
  const client: DocClient = {
    send: (async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
      const { input } = cmd;
      switch (cmd.constructor.name) {
        case "GetCommand":
          return { Item: items.get(input.Key.pk) };
        case "PutCommand": {
          const existing = items.get(input.Item.pk);
          if (existing && existing.v !== input.ExpressionAttributeValues[":expected"]) {
            throw new ConditionalCheckFailedException({ message: "conflict", $metadata: {} });
          }
          items.set(input.Item.pk, input.Item);
          return {};
        }
        case "UpdateCommand": {
          const cur = items.get(input.Key.pk) ?? { pk: input.Key.pk, hits: 0 };
          cur.hits = (cur.hits as number) + input.ExpressionAttributeValues[":w"];
          items.set(input.Key.pk, cur);
          return { Attributes: { hits: cur.hits } };
        }
        default:
          throw new Error(`unexpected command ${cmd.constructor.name}`);
      }
    }) as DocClient["send"],
  };
  return { client, items };
}

const JD = "We are hiring a Junior Frontend Engineer with React and strong JavaScript skills to build UI components.";

function harness(opts: { perMinute?: number; perDay?: number } = {}) {
  const { client, items } = fakeDynamo();
  const db = new DynamoStore(client, "t");
  const calls: string[] = [];
  /** A new SessionStore + service per request, like separate Lambda instances sharing only DynamoDB. */
  const request = async (path: string, body: unknown, ip = "1.2.3.4") => {
    const fake = fakeGenerate({
      job_analysis: jobOutput(),
      interview_blueprint: blueprintOutput(),
      first_question: { openingText: "Hi, I'm Maya.", question: questionDraft() },
      live_turn: () => liveTurnOutput(),
      live_turn_eval: () => liveTurnEvalOutput(),
      final_report: reportOutput(),
    });
    const store = new SessionStore();
    const app = createLambdaApp({
      service: new InterviewService(fake.generate, store),
      store,
      db,
      model: "test-model",
      httpRequestsPerMinutePerIp: opts.perMinute ?? 60,
      geminiCallsPerDay: opts.perDay ?? 0,
      sessionTtlMs: 3_600_000,
    });
    const event: UrlEvent = {
      rawPath: path,
      body: JSON.stringify(body),
      requestContext: { http: { method: "POST", sourceIp: ip } },
    };
    const res = await app(event);
    calls.push(...fake.calls);
    return { status: res.statusCode, body: JSON.parse(res.body), headers: res.headers };
  };
  return { request, items, calls, db };
}

const analyzeBody = { jobDescription: JD, interviewMode: "mixed", preferredLength: "standard" };

describe("Lambda app", () => {
  it("runs a whole interview with every request on a fresh instance", async () => {
    const { request, items } = harness();

    const analyzed = await request("/api/interview/analyze", analyzeBody);
    expect(analyzed.status).toBe(200);
    const sessionId = analyzed.body.sessionId as string;
    expect(items.has(`S#${sessionId}`)).toBe(true);

    const started = await request("/api/interview/start", { sessionId });
    expect(started.status).toBe(200);
    expect(started.body.turnId).toBe(1);

    const answered = await request("/api/interview/respond", {
      sessionId,
      turnId: 1,
      questionId: started.body.firstQuestion.id,
      candidateTranscript: "State lives in the component; props come from the parent.",
      completionReason: "manual",
      elapsedSeconds: 30,
    });
    expect(answered.status).toBe(200);
    expect(answered.body.nextTurnId).toBe(2);
    expect(answered.body.progress.questionsAsked).toBe(2);

    const finished = await request("/api/interview/finish", { sessionId, transcript: [], retry: false });
    expect(finished.status).toBe(200);
    expect(finished.body.report.recommendation).toBeDefined();

    // The report is persisted: asking again on yet another instance replays it without regenerating.
    const again = await request("/api/interview/finish", { sessionId, transcript: [], retry: false });
    expect(again.body.report).toEqual(finished.body.report);
  });

  it("replays a committed answer on a later instance instead of calling Gemini again", async () => {
    const { request, calls } = harness();
    const { body: a } = await request("/api/interview/analyze", analyzeBody);
    const { body: s } = await request("/api/interview/start", { sessionId: a.sessionId });
    const req = {
      sessionId: a.sessionId,
      turnId: 1,
      questionId: s.firstQuestion.id,
      candidateTranscript: "My answer.",
      completionReason: "manual",
      elapsedSeconds: 10,
    };
    const first = await request("/api/interview/respond", req);
    const second = await request("/api/interview/respond", req);
    expect(second.body).toEqual(first.body);
    expect(calls.filter((c) => c === "live_turn")).toHaveLength(1);
  });

  it("scores an answer on a later instance and keeps it with the session", async () => {
    const { request, calls, items } = harness();
    const { body: a } = await request("/api/interview/analyze", analyzeBody);
    const { body: s } = await request("/api/interview/start", { sessionId: a.sessionId });
    const respond = await request("/api/interview/respond", {
      sessionId: a.sessionId,
      turnId: 1,
      questionId: s.firstQuestion.id,
      candidateTranscript: "My answer.",
      completionReason: "manual",
      elapsedSeconds: 10,
    });
    // The reply comes back without a scoring call...
    expect(respond.status).toBe(200);
    expect(calls).not.toContain("live_turn_eval");

    const evalReq = { sessionId: a.sessionId, questionId: s.firstQuestion.id };
    const scored = await request("/api/interview/evaluate", evalReq);
    expect(scored.body).toMatchObject({ evaluated: true });
    // ...and scoring twice does not call Gemini twice.
    const again = await request("/api/interview/evaluate", evalReq);
    expect(again.body).toMatchObject({ evaluated: false });
    expect(calls.filter((c) => c === "live_turn_eval")).toHaveLength(1);
    expect(items.size).toBeGreaterThan(0);
  });

  it("returns SESSION_NOT_FOUND for an unknown session", async () => {
    const { request } = harness();
    const res = await request("/api/interview/respond", {
      sessionId: "00000000-0000-4000-8000-000000000000",
      turnId: 1,
      questionId: "q",
      candidateTranscript: "x",
      completionReason: "manual",
      elapsedSeconds: 1,
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("SESSION_NOT_FOUND");
  });

  it("keeps a saved answer when the Gemini call fails, so a retry on another instance can reuse it", async () => {
    const { client } = fakeDynamo();
    const db = new DynamoStore(client, "t");
    const make = (responders: Record<string, unknown>) => {
      const store = new SessionStore();
      return createLambdaApp({
        service: new InterviewService(fakeGenerate(responders).generate, store),
        store,
        db,
        model: "m",
        httpRequestsPerMinutePerIp: 60,
        geminiCallsPerDay: 0,
        sessionTtlMs: 1000,
      });
    };
    const base = {
      job_analysis: jobOutput(),
      interview_blueprint: blueprintOutput(),
      first_question: { openingText: "Hi", question: questionDraft() },
    };
    const call = async (app: ReturnType<typeof make>, path: string, body: unknown) => {
      const r = await app({ rawPath: path, body: JSON.stringify(body), requestContext: { http: { method: "POST" } } });
      return { status: r.statusCode, body: JSON.parse(r.body) };
    };

    const healthy = make({ ...base, live_turn: () => liveTurnOutput(), final_report: reportOutput() });
    const a = (await call(healthy, "/api/interview/analyze", analyzeBody)).body;
    const s = (await call(healthy, "/api/interview/start", { sessionId: a.sessionId })).body;

    const broken = make({
      ...base,
      live_turn: () => {
        throw new (class extends Error {})("boom");
      },
    });
    const req = {
      sessionId: a.sessionId,
      turnId: 1,
      questionId: s.firstQuestion.id,
      candidateTranscript: "An answer worth keeping.",
      completionReason: "manual",
      elapsedSeconds: 5,
    };
    expect((await call(broken, "/api/interview/respond", req)).status).toBeGreaterThanOrEqual(500);

    // The report on a fresh instance still sees the answer that was saved before the failure.
    const report = await call(healthy, "/api/interview/finish", { sessionId: a.sessionId, transcript: [], retry: false });
    expect(report.status).toBe(200);
  });

  it("rate-limits per IP and by daily Gemini budget across instances", async () => {
    const perIp = harness({ perMinute: 2 });
    await perIp.request("/api/interview/analyze", analyzeBody, "9.9.9.9");
    await perIp.request("/api/interview/analyze", analyzeBody, "9.9.9.9");
    const blocked = await perIp.request("/api/interview/analyze", analyzeBody, "9.9.9.9");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect((await perIp.request("/api/interview/analyze", analyzeBody, "8.8.8.8")).status).toBe(200);

    const daily = harness({ perDay: 4 }); // analyze costs 3 calls
    expect((await daily.request("/api/interview/analyze", analyzeBody)).status).toBe(200);
    expect((await daily.request("/api/interview/analyze", analyzeBody)).status).toBe(429);
  });

  it("rejects a stale write instead of clobbering a newer session version", async () => {
    const { request, db } = harness();
    const { body: a } = await request("/api/interview/analyze", analyzeBody);
    const loaded = await db.load(a.sessionId);
    await db.save(loaded!.session, loaded!.version, 1000); // someone else wrote first
    await expect(db.save(loaded!.session, loaded!.version, 1000)).rejects.toMatchObject({ httpStatus: 409, retryable: true });
  });

  it("serves health and 404s unknown routes", async () => {
    const { client } = fakeDynamo();
    const store = new SessionStore();
    const app = createLambdaApp({
      service: new InterviewService(fakeGenerate({}).generate, store),
      store,
      db: new DynamoStore(client, "t"),
      model: "m",
      httpRequestsPerMinutePerIp: 60,
      geminiCallsPerDay: 0,
      sessionTtlMs: 1,
    });
    const health = await app({ rawPath: "/api/health", requestContext: { http: { method: "GET" } } });
    expect(JSON.parse(health.body)).toEqual({ ok: true, model: "m" });
    const nope = await app({ rawPath: "/nope", requestContext: { http: { method: "POST" } } });
    expect(nope.statusCode).toBe(404);
  });
});
