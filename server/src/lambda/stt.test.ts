import { describe, expect, it, vi } from "vitest";
import { DynamoStore, type DocClient } from "../persistence/dynamoStore.js";
import { createDeepgramTokenIssuer, type SttTokenIssuer } from "../services/stt/sttService.js";
import { createLambdaApp, type UrlEvent } from "./app.js";

/** In-memory stand-in for the DynamoDB counters (Update-ADD) the throttle uses. */
function fakeCounters(): DocClient {
  const items = new Map<string, number>();
  return {
    send: (async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
      if (cmd.constructor.name !== "UpdateCommand") throw new Error(`unexpected ${cmd.constructor.name}`);
      const total = (items.get(cmd.input.Key.pk) ?? 0) + cmd.input.ExpressionAttributeValues[":w"];
      items.set(cmd.input.Key.pk, total);
      return { Attributes: { hits: total } };
    }) as DocClient["send"],
  };
}

function harness(opts: { sessionsPerDay?: number; perMinute?: number; issue?: SttTokenIssuer; noStt?: boolean } = {}) {
  const issue = opts.issue ?? vi.fn(async () => ({ token: "temp-token", expiresInSeconds: 60 }));
  const app = createLambdaApp({
    service: {} as never,
    store: {} as never,
    db: new DynamoStore(fakeCounters(), "t"),
    model: "test-model",
    httpRequestsPerMinutePerIp: 60,
    geminiCallsPerDay: 0,
    sessionTtlMs: 1000,
    stt: opts.noStt
      ? undefined
      : { issue, model: "nova-3", sessionsPerDay: opts.sessionsPerDay ?? 0, requestsPerMinutePerIp: opts.perMinute ?? 60 },
  });
  const call = async (ip = "1.2.3.4") => {
    const event: UrlEvent = { rawPath: "/api/stt/token", body: "{}", requestContext: { http: { method: "POST", sourceIp: ip } } };
    const res = await app(event);
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  return { call, issue };
}

describe("POST /api/stt/token", () => {
  it("hands the browser a short-lived token and the model to ask for", async () => {
    const { call } = harness();
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ token: "temp-token", expiresInSeconds: 60, model: "nova-3" });
  });

  it("answers 404 when voice input is not configured", async () => {
    expect((await harness({ noStt: true }).call()).status).toBe(404);
  });

  it("stops at the daily session budget, and rate limits per IP independently", async () => {
    const daily = harness({ sessionsPerDay: 2 });
    expect((await daily.call()).status).toBe(200);
    expect((await daily.call("5.6.7.8")).status).toBe(200);
    const over = await daily.call();
    expect(over.status).toBe(429);
    expect(over.body.error.retryable).toBe(false);

    const perIp = harness({ perMinute: 1 });
    expect((await perIp.call()).status).toBe(200);
    expect((await perIp.call()).status).toBe(429);
    expect((await perIp.call("9.9.9.9")).status).toBe(200);
  });

  it("maps a Deepgram failure to a retryable 502 without leaking details", async () => {
    const { call } = harness({
      issue: async () => {
        throw new Error("Deepgram responded 401: bad key");
      },
    });
    const res = await call();
    expect(res.status).toBe(502);
    expect(res.body.error.retryable).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("bad key");
  });
});

describe("createDeepgramTokenIssuer", () => {
  it("asks Deepgram for a short-lived grant with the server's key", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ access_token: "jwt", expires_in: 30 }), { status: 200 }));
    const issued = await createDeepgramTokenIssuer({ apiKey: "secret", ttlSeconds: 30, fetchFn: fetchFn as never })();
    expect(issued).toEqual({ token: "jwt", expiresInSeconds: 30 });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.deepgram.com/v1/auth/grant");
    expect((init.headers as Record<string, string>).Authorization).toBe("Token secret");
    expect(JSON.parse(init.body as string)).toEqual({ ttl_seconds: 30 });
  });

  it("fails when Deepgram refuses", async () => {
    const fetchFn = vi.fn(async () => new Response("nope", { status: 401 }));
    await expect(createDeepgramTokenIssuer({ apiKey: "bad", fetchFn: fetchFn as never })()).rejects.toThrow(/401/);
  });
});
