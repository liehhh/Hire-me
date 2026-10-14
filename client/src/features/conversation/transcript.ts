// Accumulates the candidate's answer from speech-recognition events.
// Browsers (notably Chrome on Android, and Chrome after an auto-restart)
// can re-emit text that was already finalized, so new final chunks are
// merged by word overlap instead of blindly appended.

const wordsOf = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Minimum overlapping words before a chunk is treated as a repeat. */
const MIN_OVERLAP = 3;

/**
 * Appends `chunk` to `existing`, dropping any prefix of `chunk` that merely
 * repeats the end of `existing`. A chunk that is entirely a repeat of the
 * existing tail is ignored.
 */
export function appendFinalChunk(existing: string, chunk: string): string {
  const next = chunk.trim();
  if (!next) return existing;
  if (!existing.trim()) return next;

  const a = wordsOf(existing);
  const b = wordsOf(next);
  if (b.length === 0) return existing;

  // Whole chunk already at the end of the transcript (duplicate final event).
  const tail = a.slice(-b.length);
  if (b.length >= MIN_OVERLAP && tail.join(" ") === b.join(" ")) return existing;

  // Longest suffix of `existing` that is a prefix of `chunk`.
  let overlap = 0;
  for (let k = Math.min(a.length, b.length); k >= MIN_OVERLAP; k--) {
    if (a.slice(-k).join(" ") === b.slice(0, k).join(" ")) {
      overlap = k;
      break;
    }
  }
  if (overlap === 0) return `${existing.trimEnd()} ${next}`;

  // Drop the first `overlap` words of the original chunk (keeping its punctuation).
  const rawWords = next.split(/\s+/);
  let seen = 0;
  let cut = 0;
  while (cut < rawWords.length && seen < overlap) {
    if (wordsOf(rawWords[cut]).length > 0) seen++;
    cut++;
  }
  const rest = rawWords.slice(cut).join(" ");
  return rest ? `${existing.trimEnd()} ${rest}` : existing;
}
