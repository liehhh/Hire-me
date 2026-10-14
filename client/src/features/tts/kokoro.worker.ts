/// <reference lib="webworker" />
import { KokoroTTS, TextSplitterStream } from "kokoro-js";
import { DEFAULT_KOKORO_VOICE, KOKORO_MODEL_ID, type KokoroDevice, type TTSWorkerRequest } from "./kokoroTypes";
import {
  createKokoroWorkerHandler,
  createProgressAggregator,
  type KokoroEngine,
} from "./kokoroWorkerCore";

// Kokoro inference runs here, off the main thread, so model loading and
// audio generation never stall React rendering, the avatar's render loop,
// or microphone capture.
//
// Model weights are cached by transformers.js in the browser Cache Storage
// ("transformers-cache") and voice embeddings by kokoro-js ("kokoro-voices"),
// so after the first visit the model is loaded from disk, not the network.

declare const self: DedicatedWorkerGlobalScope;

async function hasWebGPU(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

async function loadEngine(onProgress: (progress: number) => void) {
  const progress_callback = createProgressAggregator(onProgress);
  // kokoro-js recommends fp32 on WebGPU (lower precisions produce artifacts
  // there) and quantized q8 on the WASM backend (smaller, fast on CPU).
  // These are Kokoro's own execution backends — not a different TTS engine.
  let device: KokoroDevice = (await hasWebGPU()) ? "webgpu" : "wasm";
  let tts: KokoroTTS;
  try {
    tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
      dtype: device === "webgpu" ? "fp32" : "q8",
      device,
      progress_callback,
    });
  } catch (err) {
    if (device !== "webgpu") throw err;
    // Some GPUs/drivers expose an adapter but fail session creation.
    device = "wasm";
    tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
      dtype: "q8",
      device,
      progress_callback,
    });
  }
  // The first inference is much slower than later ones (WebGPU shader
  // compilation, WASM/ONNX initialisation). Pay that cost here, during
  // loading, instead of on the interviewer's first sentence.
  try {
    await tts.generate("Hello.", { voice: DEFAULT_KOKORO_VOICE } as Parameters<KokoroTTS["generate"]>[1]);
  } catch {
    // Warm-up is only an optimisation.
  }
  const engine: KokoroEngine = {
    stream(text, options) {
      // kokoro-js 1.2.1's stream(string) never closes its internal sentence
      // splitter, so the final sentence is never flushed and the generator
      // hangs. Passing an explicitly closed splitter avoids that.
      const splitter = new TextSplitterStream();
      splitter.push(text);
      splitter.close();
      return tts.stream(splitter, options as Parameters<KokoroTTS["stream"]>[1]);
    },
  };
  return { engine, device };
}

const handleMessage = createKokoroWorkerHandler(loadEngine, (message, transfer) =>
  self.postMessage(message, transfer ?? [])
);

self.addEventListener("message", (event: MessageEvent<TTSWorkerRequest>) => {
  void handleMessage(event.data);
});
