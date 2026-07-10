import type { RetrievedContext, Citation } from "./types";

/**
 * Reduce retrieved contexts to a deduped citation list (by title + page),
 * preserving the order in which each (title, page) was first seen.
 */
export function extractCitations(contexts: RetrievedContext[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of contexts) {
    const key = `${c.title}::${c.page}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: c.title, page: c.page });
  }
  return out;
}

/**
 * Enrich citations with the highest-scoring matching context passage
 * (truncated) so stored messages can restore hover previews after reload.
 */
export function attachQuotes(
  citations: Citation[],
  contexts: RetrievedContext[],
  maxLen = 500,
): Citation[] {
  return citations.map((cit) => {
    let best: RetrievedContext | undefined;
    for (const c of contexts) {
      if (c.title !== cit.title || c.page !== cit.page) continue;
      if (!best || c.score > best.score) best = c;
    }
    if (!best) return { ...cit };
    const text = best.text.length > maxLen ? best.text.slice(0, maxLen) + "…" : best.text;
    return { ...cit, text };
  });
}
