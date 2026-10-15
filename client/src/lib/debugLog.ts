// Crash breadcrumb trail that survives reloads. Entries are written to
// localStorage as they happen, so after a tab is killed and reloaded the last
// entries show where the previous page session ended. Shown by <DebugOverlay>
// at ?debug=1.
//
// It also answers "was that a navigation or a kill?": `pagehide` fires for
// every navigation, reload and tab close, but NOT when the browser terminates
// the page process. Each session records a heartbeat and a clean-exit flag, so
// a session that ends without `pagehide` is reported as terminated.

const LOG_KEY = "debug-breadcrumbs";
const SESSION_KEY = "debug-session";
const MAX_ENTRIES = 120;
const HEARTBEAT_MS = 1000;

/** Identifies this page load in the log. */
export const SESSION_ID = Math.random().toString(36).slice(2, 8);

let lastBreadcrumb = "boot";

interface SessionRecord {
  sid: string;
  href: string;
  /** Last breadcrumb written by that session. */
  stage: string;
  /** Epoch ms of its last heartbeat. */
  alive: number;
  visibility: string;
  /** True once `pagehide` fired (navigation, reload, close — not a kill). */
  clean: boolean;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable — diagnostics only.
  }
}

export function breadcrumb(message: string): void {
  lastBreadcrumb = message;
  const entries = read<string[]>(LOG_KEY, []);
  entries.push(`${SESSION_ID} ${new Date().toISOString().slice(11, 23)} ${message}`);
  write(LOG_KEY, entries.slice(-MAX_ENTRIES));
}

export function readBreadcrumbs(): string[] {
  return read<string[]>(LOG_KEY, []);
}

export function clearBreadcrumbs(): void {
  try {
    localStorage.removeItem(LOG_KEY);
  } catch {
    // ignore
  }
}

/** Plain-language verdict on how the previous page session ended. */
export function describePreviousSession(prev: SessionRecord | null, now = Date.now()): string | null {
  if (!prev) return null;
  if (prev.clean) return `previous session ${prev.sid} ended normally (pagehide fired: navigation, reload or close)`;
  const ago = Math.round((now - prev.alive) / 1000);
  const where = prev.visibility === "hidden" ? "while the tab was in the BACKGROUND" : "while the tab was in the FOREGROUND";
  return (
    `previous session ${prev.sid} ENDED WITHOUT pagehide, ${where}, last heartbeat ${ago}s ago at "${prev.stage}" ` +
    `(${prev.href}). The page process was terminated or crashed — it was not an app navigation.`
  );
}

let tracking = false;

/**
 * Starts the heartbeat for this page load and returns the verdict on the
 * previous one. Safe to call more than once.
 */
export function startSessionTracking(): string | null {
  if (typeof window === "undefined" || tracking) return null;
  tracking = true;

  const prev = read<SessionRecord | null>(SESSION_KEY, null);
  const verdict = describePreviousSession(prev);

  const record = (patch: Partial<SessionRecord> = {}) =>
    write(SESSION_KEY, {
      sid: SESSION_ID,
      href: location.pathname + location.search,
      stage: lastBreadcrumb,
      alive: Date.now(),
      visibility: document.visibilityState,
      clean: false,
      ...patch,
    } satisfies SessionRecord);

  record();
  setInterval(record, HEARTBEAT_MS);
  window.addEventListener("pagehide", () => record({ clean: true }));
  // Restored from the back/forward cache: running again, so not clean.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) record();
  });
  return verdict;
}
