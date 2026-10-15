// Crash-loop guard for on-device Kokoro.
//
// Some phones have the whole page process terminated while Kokoro runs its
// first inference. That can't be caught in JS, but it can be detected: an
// "attempt" is recorded when loading starts and cleared when the first audio
// is produced, or on `pagehide` (a normal navigation/close). An attempt still
// present on the next page load means the previous page died mid-attempt, so
// voice is switched off for a while and the interview continues as text
// instead of crashing again.

const KEY = "kokoro-guard";
export const UNSAFE_FOR_MS = 24 * 60 * 60 * 1000;

interface GuardState {
  attempt?: { startedAt: number };
  unsafeUntil?: number;
}

let evaluated = false;
let listenerAdded = false;

function readState(): GuardState {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as GuardState;
  } catch {
    return {};
  }
}

function writeState(state: GuardState): void {
  try {
    if (!state.attempt && !state.unsafeUntil) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable — the guard just doesn't engage.
  }
}

/** Converts a leftover attempt from a previous page load into an "unsafe" verdict. Runs once per page load. */
function evaluate(now: number): void {
  if (evaluated) return;
  evaluated = true;
  const state = readState();
  if (state.attempt) {
    writeState({ unsafeUntil: now + UNSAFE_FOR_MS });
  } else if (state.unsafeUntil && state.unsafeUntil <= now) {
    writeState({});
  }
}

/** True when a previous page died while Kokoro was starting up on this device. */
export function isKokoroUnsafe(now = Date.now()): boolean {
  if (typeof localStorage === "undefined") return false;
  evaluate(now);
  const { unsafeUntil } = readState();
  return Boolean(unsafeUntil && unsafeUntil > now);
}

/** Records that Kokoro is starting. Call right before loading the model. */
export function beginKokoroAttempt(now = Date.now()): void {
  if (typeof localStorage === "undefined") return;
  evaluate(now);
  writeState({ ...readState(), attempt: { startedAt: now } });
  if (!listenerAdded && typeof window !== "undefined") {
    listenerAdded = true;
    // pagehide does not fire when the browser kills the page, so a normal
    // close or navigation clears the attempt and a kill leaves it behind.
    window.addEventListener("pagehide", endKokoroAttempt);
  }
}

/** Clears the in-progress marker: Kokoro produced audio, failed with a catchable error, or the page closed normally. */
export function endKokoroAttempt(): void {
  if (typeof localStorage === "undefined") return;
  const { attempt: _attempt, ...rest } = readState();
  writeState(rest);
}

/** Manual override (?tts=reset): forget any previous verdict. */
export function resetKokoroGuard(): void {
  writeState({});
}

/** Test-only. */
export function resetKokoroGuardForTests(): void {
  evaluated = false;
  listenerAdded = false;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
