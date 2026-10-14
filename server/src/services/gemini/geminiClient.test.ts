import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

process.env.GEMINI_API_KEY = "test-key";
process.env.GEMINI_RPM = "0";
process.env.GEMINI_MODEL = "gemini-test-flash";

const generateContent = vi.fn();
const generateContentStream = vi.fn();
vi.mock("@google/genai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/genai")>();
  return {
    ...actual,
    GoogleGenAI: class {
      models = { generateContent, generateContentStream };
    },
  };
});

const { ApiError } = await import("@google/genai");
const { earlyFields, generateStructured, parseFieldsBefore } = await import("./geminiClient.js");
const { classifyGeminiError, parseRetryAfterMs } = await import("./geminiErrors.js");
const { toGeminiSchema, liveTurnOutputSchema } = await import("./geminiSchemas.js");

const schema = z.object({ ok: z.boolean() });
const request = { task: "test", systemInstruction: "s", prompt: "p", schema, maxOutputTokens: 50 };
const ok = (text: string, finishReason = "STOP") => ({ text, candidates: [{ finishReason }] });
const rateLimited = (delay: string) =>
  new ApiError({ status: 429, message: `{"error":{"details":[{"retryDelay":"${delay}"}]}}` });

describe("generateStructured", () => {
  beforeEach(() => {
    generateContent.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("retries a 429 honouring the requested delay", async () => {
    generateContent.mockRejectedValueOnce(rateLimited("3s")).mockResolvedValueOnce(ok('{"ok":true}'));
    const p = generateStructured(request);
    await vi.advanceTimersByTimeAsync(2_900);
    expect(generateContent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    await expect(p).resolves.toEqual({ ok: true });
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it("does not wait out long quota windows", async () => {
    generateContent.mockRejectedValue(rateLimited("3600s"));
    await expect(generateStructured(request)).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 3600 });
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("retries invalid JSON at most twice", async () => {
    generateContent.mockResolvedValue(ok("not json"));
    const p = generateStructured(request);
    const assertion = expect(p).rejects.toMatchObject({ code: "GEMINI_INVALID_OUTPUT" });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(generateContent).toHaveBeenCalledTimes(3);
  });

  it("rejects schema-invalid output", async () => {
    generateContent.mockResolvedValueOnce(ok('{"ok":"yes"}')).mockResolvedValueOnce(ok('{"ok":false}'));
    const p = generateStructured(request);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(p).resolves.toEqual({ ok: false });
  });

  it("does not retry safety blocks", async () => {
    generateContent.mockResolvedValue(ok("", "SAFETY"));
    await expect(generateStructured(request)).rejects.toMatchObject({ code: "GEMINI_SAFETY_BLOCKED" });
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("reports empty responses", async () => {
    generateContent.mockResolvedValue(ok(""));
    const p = generateStructured(request);
    const assertion = expect(p).rejects.toMatchObject({ code: "GEMINI_EMPTY_RESPONSE" });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it("times out slow calls", async () => {
    generateContent.mockImplementation(
      ({ config }: { config: { abortSignal: AbortSignal } }) =>
        new Promise((_r, reject) => config.abortSignal.addEventListener("abort", () => reject(new Error("aborted"))))
    );
    const p = generateStructured({ ...request, timeoutMs: 1_000 });
    const assertion = expect(p).rejects.toMatchObject({ code: "GEMINI_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(generateContent).toHaveBeenCalledTimes(3);
  });

  it("stops immediately when the caller aborts", async () => {
    const controller = new AbortController();
    generateContent.mockImplementation(
      ({ config }: { config: { abortSignal: AbortSignal } }) =>
        new Promise((_r, reject) => config.abortSignal.addEventListener("abort", () => reject(new Error("aborted"))))
    );
    const p = generateStructured({ ...request, signal: controller.signal });
    controller.abort();
    await expect(p).rejects.toMatchObject({ code: "CANCELLED" });
    expect(generateContent.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe("error classification", () => {
  it("parses both retry delay formats", () => {
    expect(parseRetryAfterMs('"retryDelay": "37s"')).toBe(37_000);
    expect(parseRetryAfterMs("Please retry in 5h43m49.3s.")).toBe(Math.ceil((5 * 3600 + 43 * 60 + 49.3) * 1000));
  });

  it("treats a retired model and a zero free-tier quota as configuration errors", () => {
    expect(classifyGeminiError(new ApiError({ status: 404, message: "no longer available" }), "m").code).toBe(
      "GEMINI_MODEL_UNAVAILABLE"
    );
    expect(
      classifyGeminiError(new ApiError({ status: 429, message: "Quota exceeded ... limit: 0, model: m" }), "m").code
    ).toBe("GEMINI_MODEL_UNAVAILABLE");
  });
});

describe("toGeminiSchema", () => {
  it("emits only Gemini-supported keys and requires every field", () => {
    const schema = toGeminiSchema(liveTurnOutputSchema) as { required: string[]; properties: Record<string, unknown> };
    const text = JSON.stringify(schema);
    expect(text).not.toContain("$schema");
    expect(text).not.toContain('"default"');
    expect(text).not.toContain('"const"');
    expect(schema.required).toEqual(Object.keys(schema.properties));
    expect(text).toContain('"null"'); // nullable fields survive
  });
});

describe("early fields", () => {
  it("parses the fields written before a top-level key", () => {
    expect(parseFieldsBefore('{"a": "x", "b": [1, 2], "evaluation": {"rel', "evaluation")).toEqual({ a: "x", b: [1, 2] });
    expect(parseFieldsBefore('{"a": "x", "b": [1', "evaluation")).toBeUndefined();
    // A key-like sequence inside a string is escaped, so it never matches.
    expect(parseFieldsBefore('{"a": "say \\"x\\", \\"evaluation\\": no', "evaluation")).toBeUndefined();
  });

  it("hands over the reply while the rest of the response is still streaming", async () => {
    const early = vi.fn();
    const full = '{"reply": "Hello", "evaluation": {"score": 3}}';
    let releaseLast!: () => void;
    const gate = new Promise<void>((r) => (releaseLast = r));
    generateContentStream.mockResolvedValueOnce(
      (async function* () {
        yield { text: full.slice(0, 34), candidates: [{}] };
        await gate;
        yield { text: full.slice(34), candidates: [{ finishReason: "STOP" }] };
      })()
    );
    const schema = z.object({ reply: z.string(), evaluation: z.object({ score: z.number() }) });
    const result = generateStructured({
      ...request,
      schema,
      early: earlyFields({ beforeKey: "evaluation", schema: z.object({ reply: z.string() }), onEarly: early }),
    });
    await vi.waitFor(() => expect(early).toHaveBeenCalledWith({ reply: "Hello" }));
    releaseLast();
    expect(await result).toEqual({ reply: "Hello", evaluation: { score: 3 } });
    expect(early).toHaveBeenCalledTimes(1);
  });
});
