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
