import type { Env, RetrievedContext, ChunkMetadata } from "./types";

/** Map raw Vectorize matches into RetrievedContext, dropping any without text. */
export function matchesToContexts(matches: VectorizeMatch[]): RetrievedContext[] {
  const out: RetrievedContext[] = [];
  for (const m of matches) {
    const md = m.metadata as unknown as ChunkMetadata | undefined;
    if (!md || typeof md.text !== "string") continue;
    out.push({
      text: md.text,
      title: md.title,
      page: md.page,
      sourceFile: md.source_file,
      score: m.score ?? 0,
    });
  }
  return out;
}

/**
 * Merge context lists from multiple search queries: dedupe identical chunks
 * (same source file, page, and text) keeping the best score, sort by score
 * descending, and cap the result.
 */
export function mergeContexts(lists: RetrievedContext[][], cap = 8): RetrievedContext[] {
  const byKey = new Map<string, RetrievedContext>();
  for (const list of lists) {
    for (const c of list) {
      const key = `${c.sourceFile}::${c.page}::${c.text}`;
      const existing = byKey.get(key);
      if (!existing || c.score > existing.score) byKey.set(key, c);
    }
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, cap);
}

/** Query the Vectorize index with a query embedding and return top-k contexts. */
export async function queryContexts(
  env: Env,
  queryVector: number[],
  k: number,
): Promise<RetrievedContext[]> {
  const result = await env.VECTORIZE.query(queryVector, {
    topK: k,
    returnMetadata: true,
  });
  return matchesToContexts(result.matches ?? []);
}
