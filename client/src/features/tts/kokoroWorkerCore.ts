import type { KokoroDevice, TTSWorkerRequest, TTSWorkerResponse } from "./kokoroTypes";

// The worker's message-handling logic, kept free of `self`/kokoro-js imports
// so it can be unit-tested with a fake engine. kokoro.worker.ts wires it to
// the real KokoroTTS model and the worker's postMessage.

/** The subset of kokoro-js's KokoroTTS this worker relies on. */
export interface KokoroEngine {
  stream(
    text: string,
    options: { voice: string; speed?: number }
  ): AsyncIterable<{ text: string; audio: { audio: Float32Array; sampling_rate: number } }>;
}

export type EngineLoader = (
  onProgress: (progress: number) => void
) => Promise<{ engine: KokoroEngine; device: KokoroDevice }>;

export type PostFn = (message: TTSWorkerResponse, transfer?: Transferable[]) => void;

// Kokoro pads every sentence with silence on both ends. Played back to back,
// that padding adds up to a noticeable pause between sentences, so it is cut
// down to a short natural beat.
const SILENCE_THRESHOLD = 0.008;
const KEEP_LEAD_S = 0.03;
const KEEP_TAIL_S = 0.12;

/** Trims leading/trailing near-silence, keeping a short natural margin. */
export function trimSilence(samples: Float32Array, sampleRate: number): Float32Array<ArrayBuffer> {
  let first = 0;
  while (first < samples.length && Math.abs(samples[first]) < SILENCE_THRESHOLD) first++;
  if (first === samples.length) return samples.slice(); // all silence: leave as is
  let last = samples.length - 1;
  while (last > first && Math.abs(samples[last]) < SILENCE_THRESHOLD) last--;
  const start = Math.max(0, first - Math.round(KEEP_LEAD_S * sampleRate));
  const end = Math.min(samples.length, last + 1 + Math.round(KEEP_TAIL_S * sampleRate));
  return samples.slice(start, end);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createKokoroWorkerHandler(loadEngine: EngineLoader, post: PostFn) {
  // Singleton model load: every load-model/synthesize shares this promise,
  // so duplicate requests (e.g. React Strict Mode double effects) never
  // trigger a second download or a second ONNX session.
  let loadPromise: Promise<KokoroEngine> | null = null;
  // Only the most recent synthesize request is allowed to keep producing
  // audio; anything older is considered superseded.
  let activeRequestId: number | null = null;
  // ONNX sessions shouldn't run concurrently, so generations are serialized.
  // A superseded generation stops after its current sentence, so a new
  // request waits at most one sentence's inference time.
  let generationChain: Promise<void> = Promise.resolve();

  const ensureLoaded = (): Promise<KokoroEngine> => {
    if (!loadPromise) {
      post({ type: "loading", progress: 0 });
      loadPromise = loadEngine((progress) => post({ type: "loading", progress })).then(
        ({ engine, device }) => {
          post({ type: "ready", device });
          return engine;
        }
      );
      // A failed load must be retryable, so don't cache the rejection.
      loadPromise.catch(() => {
        loadPromise = null;
      });
    }
    return loadPromise;
  };

  const isCurrent = (requestId: number) => activeRequestId === requestId;

  async function synthesize(req: Extract<TTSWorkerRequest, { type: "synthesize" }>) {
    const engine = await ensureLoaded();
    if (!isCurrent(req.requestId)) return;

    let chunkIndex = 0;
    for await (const chunk of engine.stream(req.text, { voice: req.voice, speed: req.speed })) {
      // Checked after each sentence: the only point where a cancel message
      // can have been processed while inference was in flight.
      if (!isCurrent(req.requestId)) return;
      const sampleRate = chunk.audio.sampling_rate;
      // trimSilence() returns a standalone copy, so its buffer can be transferred.
      const samples = trimSilence(chunk.audio.audio, sampleRate);
      post(
        {
          type: "audio",
          requestId: req.requestId,
          chunkIndex: chunkIndex++,
          text: chunk.text,
          audioData: samples.buffer,
          sampleRate,
          duration: samples.length / sampleRate,
        },
        [samples.buffer]
      );
    }
    if (isCurrent(req.requestId)) {
      activeRequestId = null;
      post({ type: "done", requestId: req.requestId });
    }
  }

  return function handleMessage(req: TTSWorkerRequest): Promise<void> {
    switch (req.type) {
      case "load-model":
        return ensureLoaded().then(
          () => undefined,
          (err) => post({ type: "error", message: errorMessage(err) })
        );

      case "cancel":
        if (req.requestId === undefined || req.requestId === activeRequestId) {
          activeRequestId = null;
        }
        return Promise.resolve();

      case "synthesize": {
        activeRequestId = req.requestId;
        const run = generationChain.then(() =>
          synthesize(req).catch((err) => {
            if (isCurrent(req.requestId)) activeRequestId = null;
            post({ type: "error", requestId: req.requestId, message: errorMessage(err) });
          })
        );
        generationChain = run;
        return run;
      }
    }
  };
}

/** Collapses transformers.js per-file download events into one 0–100 figure. */
export function createProgressAggregator(onProgress: (percent: number) => void) {
  const files = new Map<string, { loaded: number; total: number }>();
  return (info: { status: string; file?: string; loaded?: number; total?: number }) => {
    if (info.status !== "progress" || !info.file || !info.total) return;
    files.set(info.file, { loaded: info.loaded ?? 0, total: info.total });
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    onProgress(Math.min(100, Math.round((loaded / total) * 100)));
  };
}
