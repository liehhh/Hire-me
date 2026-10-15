/** Phones and tablets, including iPadOS (which reports a Mac user agent). */
export function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

/** Reads a boolean-style URL flag such as ?avatar=0. */
export function urlFlag(name: string): string | null {
  if (typeof location === "undefined") return null;
  return new URLSearchParams(location.search).get(name);
}
