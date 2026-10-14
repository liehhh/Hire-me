import type {
  KokoroDevice,
  SynthesisOutcome,
  TTSAudioChunk,
  TTSWorkerRequest,
  TTSWorkerResponse,
} from "./kokoroTypes";

// Main-thread facade over the Kokoro Web Worker. Owns the worker, dedupes
// model loading, tags each synthesis with a requestId, and drops audio from
// requests that have since been cancelled or superseded.

export interface WorkerLike {
  postMessage(message: TTSWorkerRequest): void;
  addEventListener(type: "message", listener: (event: MessageEvent<TTSWorkerResponse>) => void): void;
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  terminate(): void;
}

export type ModelState = "idle" | "loading" | "ready" | "error";

export interface KokoroClientStatus {
  modelState: ModelState;
  /** Download progress, 0–100, while modelState is "loading". */
  progress: number | null;
  device: KokoroDevice | null;
  error: string | null;
}

interface PendingRequest {
  onChunk: (chunk: TTSAudioChunk) => void;
  resolve: (outcome: SynthesisOutcome) => void;
  reject: (err: Error) => void;
}

export class KokoroClient {
  private worker: WorkerLike;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private loadPromise: Promise<void> | null = null;
  private loadSettlers: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private listeners = new Set<(status: KokoroClientStatus) => void>();
  private disposed = false;
  status: KokoroClientStatus = { modelState: "idle", progress: null, device: null, error: null };

  constructor(createWorker: () => WorkerLike) {
    this.worker = createWorker();
    this.worker.addEventListener("message", (event) => this.handleMessage(event.data));
    this.worker.addEventListener("error", (event) => {
      this.failAll(new Error(event.message || "The Kokoro TTS worker crashed."));
    });
  }

  subscribe(listener: (status: KokoroClientStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  /** Loads the model once; concurrent and repeated calls share one load. */
  load(voice: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Kokoro client disposed."));
    if (this.status.modelState === "ready") return Promise.resolve();
    if (!this.loadPromise) {
      this.loadPromise = new Promise<void>((resolve, reject) => {
        this.loadSettlers = { resolve, reject };
      });
      this.setStatus({ modelState: "loading", progress: 0, error: null });
      this.worker.postMessage({ type: "load-model", voice });
    }
    return this.loadPromise;
  }

  /**
   * Synthesizes text sentence by sentence. Starting a new synthesis
   * implicitly cancels the previous one. Resolves "cancelled" if cancel()
   * (or a newer synthesize) supersedes it before it finishes.
   */
  synthesize(
    text: string,
    options: { voice: string; speed?: number },
    onChunk: (chunk: TTSAudioChunk) => void
  ): { requestId: number; done: Promise<SynthesisOutcome> } {
    this.cancel();
    const requestId = this.nextRequestId++;
    const done = new Promise<SynthesisOutcome>((resolve, reject) => {
      this.pending.set(requestId, { onChunk, resolve, reject });
    });
    if (this.disposed) {
      this.settle(requestId, "reject", new Error("Kokoro client disposed."));
    } else {
      this.worker.postMessage({ type: "synthesize", requestId, text, ...options });
    }
    return { requestId, done };
  }

  /** Cancels any in-flight synthesis. Its pending audio will be discarded. */
  cancel(): void {
    if (this.pending.size === 0) return;
    for (const requestId of [...this.pending.keys()]) {
      this.settle(requestId, "resolve", "cancelled");
    }
    if (!this.disposed) this.worker.postMessage({ type: "cancel" });
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancel();
    this.disposed = true;
    this.worker.terminate();
    this.loadSettlers?.reject(new Error("Kokoro client disposed."));
    this.loadSettlers = null;
    this.loadPromise = null;
    this.listeners.clear();
  }

  private handleMessage(msg: TTSWorkerResponse) {
    switch (msg.type) {
      case "loading":
        if (!this.loadPromise) break; // stale progress after a failed load
        this.setStatus({ modelState: "loading", progress: msg.progress ?? this.status.progress });
        break;
      case "ready":
        this.setStatus({ modelState: "ready", progress: 100, device: msg.device, error: null });
        this.loadSettlers?.resolve();
        this.loadSettlers = null;
        break;
      case "audio":
        // Stale chunks (from cancelled requests) have no pending entry.
        this.pending.get(msg.requestId)?.onChunk({
          chunkIndex: msg.chunkIndex,
          text: msg.text,
          audioData: msg.audioData,
          sampleRate: msg.sampleRate,
          duration: msg.duration,
        });
        break;
      case "done":
        this.settle(msg.requestId, "resolve", "completed");
        break;
      case "error":
        if (msg.requestId !== undefined) {
          this.settle(msg.requestId, "reject", new Error(msg.message));
        } else {
          this.failLoad(new Error(msg.message));
        }
        break;
    }
  }

  private failLoad(err: Error) {
    this.setStatus({ modelState: "error", progress: null, error: err.message });
    this.loadSettlers?.reject(err);
    this.loadSettlers = null;
    // Allow a retry to issue a fresh load-model request.
    this.loadPromise = null;
  }

  private failAll(err: Error) {
    if (this.status.modelState !== "ready") this.failLoad(err);
    for (const requestId of [...this.pending.keys()]) this.settle(requestId, "reject", err);
  }

  private settle(requestId: number, how: "resolve", value: SynthesisOutcome): void;
  private settle(requestId: number, how: "reject", value: Error): void;
  private settle(requestId: number, how: "resolve" | "reject", value: SynthesisOutcome | Error) {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    if (how === "resolve") entry.resolve(value as SynthesisOutcome);
    else entry.reject(value as Error);
  }

  private setStatus(patch: Partial<KokoroClientStatus>) {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener(this.status);
  }
}

// --- Shared instance ---------------------------------------------------------
// One worker + one model for the whole page. Reference-counted so the
// worker is terminated when the last consumer unmounts, with a short grace
// period so React Strict Mode's mount → unmount → mount cycle (and quick
// remounts) reuse the same instance instead of reloading the model.

const DISPOSE_GRACE_MS = 2000;

function createDefaultWorker(): WorkerLike {
  return new Worker(new URL("./kokoro.worker.ts", import.meta.url), {
    type: "module",
  }) as unknown as WorkerLike;
}

let sharedClient: KokoroClient | null = null;
let refCount = 0;
let disposeTimer: ReturnType<typeof setTimeout> | null = null;

export function acquireKokoroClient(createWorker: () => WorkerLike = createDefaultWorker): KokoroClient {
  if (disposeTimer) {
    clearTimeout(disposeTimer);
    disposeTimer = null;
  }
  if (!sharedClient) sharedClient = new KokoroClient(createWorker);
  refCount++;
  return sharedClient;
}

export function releaseKokoroClient(client: KokoroClient): void {
  if (client !== sharedClient) return;
  refCount = Math.max(0, refCount - 1);
  if (refCount > 0) return;
  disposeTimer = setTimeout(() => {
    disposeTimer = null;
    if (refCount === 0 && sharedClient === client) {
      client.dispose();
      sharedClient = null;
    }
  }, DISPOSE_GRACE_MS);
}

/** Test-only: drops the shared instance so each test gets a fresh worker. */
export function resetSharedKokoroClientForTests(): void {
  if (disposeTimer) clearTimeout(disposeTimer);
  disposeTimer = null;
  sharedClient?.dispose();
  sharedClient = null;
  refCount = 0;
}
