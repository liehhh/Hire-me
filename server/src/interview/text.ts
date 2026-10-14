// Text helpers for the evidence checks: comparing model output against what
// the candidate actually said.

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}'+#.\s]/gu, " ")
    .replace(/\.(?!\w)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const words = (text: string) => normalize(text).split(" ").filter(Boolean);

const STOP_WORDS = new Set(
  "a an the and or but if of to in on at for with by from as is are was were be been being it its this that these those i we you they he she my our your their me us them do did does done have has had not no so than then too very can could would should will just about into over also more most such what which who how when where why there here".split(
    " "
  )
);

export const contentWords = (text: string) => words(text).filter((w) => w.length > 2 && !STOP_WORDS.has(w));

function ngrams(tokens: string[], n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= tokens.length; i++) out.add(tokens.slice(i, i + n).join(" "));
  return out;
}

/**
 * True if `quote` appears in `corpus` exactly or as a faithful near-verbatim
 * rendering (speech-recognition punctuation/casing differences, small
 * fillers dropped). Ellipses split a quote into fragments checked separately.
 */
export function isFaithfulQuote(quote: string, corpus: string): boolean {
  const normCorpus = ` ${normalize(corpus)} `;
  const fragments = quote
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .split(/\.\.\.|…|\[[^\]]*\]/)
    .map((f) => f.trim())
    .filter((f) => words(f).length > 0);
  if (fragments.length === 0) return false;

  const corpusTokens = words(corpus);
  const corpusTrigrams = ngrams(corpusTokens, 3);
  return fragments.every((fragment) => {
    const norm = normalize(fragment);
    const tokens = norm.split(" ");
    if (normCorpus.includes(` ${norm} `)) return true;
    if (tokens.length < 4) return false;
    const grams = ngrams(tokens, 3);
    let hits = 0;
    for (const g of grams) if (corpusTrigrams.has(g)) hits++;
    return grams.size > 0 && hits / grams.size >= 0.75;
  });
}

/** Share of `claim`'s content words that occur in `corpus` (0..1). */
export function supportRatio(claim: string, corpus: string): number {
  const claimWords = contentWords(claim);
  if (claimWords.length === 0) return 0;
  const corpusSet = new Set(contentWords(corpus));
  return claimWords.filter((w) => corpusSet.has(w)).length / claimWords.length;
}

/** Word-trigram Jaccard similarity, used to catch repeated questions. */
export function similarity(a: string, b: string): number {
  const ga = ngrams(words(a), 2);
  const gb = ngrams(words(b), 2);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / (ga.size + gb.size - inter);
}

/** Case-insensitive whole-term match (handles "C#", "Node.js", "CI/CD"). */
export function mentionsTerm(text: string, term: string): boolean {
  const t = term.trim().toLowerCase();
  if (t.length < 2) return false;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "iu").test(text.toLowerCase());
}

export const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);
