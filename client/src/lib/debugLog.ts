// Tiny crash breadcrumb trail. Entries are written to localStorage as they
// happen, so after a tab is killed and reloaded (e.g. by iOS) the last entries
// show where the previous page session ended. Shown by <DebugOverlay> at ?debug=1.

const KEY = "debug-breadcrumbs";
const MAX_ENTRIES = 80;

export function breadcrumb(message: string): void {
  try {
    const entries: string[] = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    entries.push(`${new Date().toISOString().slice(11, 23)} ${message}`);
    localStorage.setItem(KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch {
    // Storage unavailable — diagnostics only.
  }
}

export function readBreadcrumbs(): string[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function clearBreadcrumbs(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
