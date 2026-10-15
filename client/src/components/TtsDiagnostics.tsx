"use client";

import { useEffect, useRef, useState } from "react";
import { AvatarContainer } from "./AvatarContainer";
import { acquireKokoroClient, releaseKokoroClient } from "../features/tts/kokoroClient";
import { DEFAULT_KOKORO_VOICE, type KokoroLoadOptions } from "../features/tts/kokoroTypes";
import { breadcrumb } from "../lib/debugLog";

// /?diag=1 runs Kokoro in isolation, then with the avatar, on the device being
// debugged. A test marks itself "pending" before it starts; if the page is
// killed mid-test, the next load reports which test did it.

const PENDING_KEY = "diag-pending";
type TestId = "A" | "B" | "C";

const TESTS: Record<TestId, { title: string; options: KokoroLoadOptions; avatar: boolean }> = {
  A: { title: "A: Kokoro only (wasm, no warm-up), say Hello", options: { device: "wasm", skipWarmup: true }, avatar: false },
  B: { title: "B: Kokoro (wasm, no warm-up) + avatar, say Hello", options: { device: "wasm", skipWarmup: true }, avatar: true },
  C: { title: "C: Kokoro only (wasm, WITH warm-up), say Hello", options: { device: "wasm" }, avatar: false },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function TtsDiagnostics() {
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState<TestId | null>(null);
  const [withAvatar, setWithAvatar] = useState(false);
  const avatarReady = useRef<(() => void) | null>(null);

  const log = (text: string) => {
    breadcrumb(`diag: ${text}`);
    setLines((l) => [...l, text]);
  };

  useEffect(() => {
    try {
      const pending = localStorage.getItem(PENDING_KEY);
      if (pending) {
        localStorage.removeItem(PENDING_KEY);
        log(`RESULT: test ${pending} never finished. The page was killed during it (no JS error, no pagehide).`);
      }
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (id: TestId) => {
    const test = TESTS[id];
    setRunning(id);
    setLines([]);
    log(`start ${test.title}`);
    try {
      localStorage.setItem(PENDING_KEY, id);
    } catch {
      // ignore
    }
    try {
      if (test.avatar) {
        log("mounting avatar...");
        const ready = new Promise<void>((resolve) => (avatarReady.current = resolve));
        setWithAvatar(true);
        await Promise.race([ready, sleep(30000)]);
        log("avatar ready (or 30s elapsed)");
      }
      const client = acquireKokoroClient();
      const t0 = performance.now();
      log("loading model...");
      await client.load(DEFAULT_KOKORO_VOICE, test.options);
      log(`model ready in ${Math.round(performance.now() - t0)}ms`);
      const t1 = performance.now();
      log("synthesizing Hello...");
      const { done } = client.synthesize("Hello.", { voice: DEFAULT_KOKORO_VOICE, speed: 1 }, (chunk) =>
        log(`chunk received: ${chunk.duration.toFixed(2)}s of audio after ${Math.round(performance.now() - t1)}ms`)
      );
      const outcome = await done;
      log(`RESULT: test ${id} PASSED (${outcome}, ${Math.round(performance.now() - t1)}ms)`);
      releaseKokoroClient(client);
      await sleep(2500); // let the shared client dispose so the next test loads fresh
    } catch (err) {
      log(`RESULT: test ${id} FAILED with a catchable error: ${String(err)}`);
    } finally {
      try {
        localStorage.removeItem(PENDING_KEY);
      } catch {
        // ignore
      }
      setWithAvatar(false);
      setRunning(null);
    }
  };

  return (
    <main className="min-h-dvh bg-black p-4 text-white">
      <h1 className="text-xl font-semibold">Voice diagnostics</h1>
      <p className="mt-1 text-sm text-white/60">
        Run one test and wait. If the page reloads, reopen /?diag=1 and it reports which test was killed. Run test A
        first, then B.
      </p>
      <div className="mt-4 flex flex-col gap-2">
        {(Object.keys(TESTS) as TestId[]).map((id) => (
          <button
            key={id}
            disabled={running !== null}
            onClick={() => void run(id)}
            className="rounded-xl bg-white/10 px-4 py-3 text-left text-sm disabled:opacity-40"
          >
            {TESTS[id].title}
          </button>
        ))}
      </div>
      <pre className="mt-4 whitespace-pre-wrap break-words text-xs text-green-400">{lines.join("\n")}</pre>
      {withAvatar && (
        <div className="mt-4 h-64">
          <AvatarContainer onReady={() => avatarReady.current?.()} />
        </div>
      )}
    </main>
  );
}
