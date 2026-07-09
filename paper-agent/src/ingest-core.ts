import { chunkText, type ChunkOptions } from "./chunk";
import type { PdfPage, VectorRecord, ChunkMetadata } from "./types";

export interface PaperMeta {
  sourceFile: string;
  title: string;
}

export interface ChunkEntry {
  id: string;
  text: string;
  metadata: ChunkMetadata;
}

/** Turn extracted pages into chunk entries with stable ids + metadata. */
export function chunksFromPages(
  pages: PdfPage[],
  meta: PaperMeta,
  opts?: ChunkOptions,
): ChunkEntry[] {
  const entries: ChunkEntry[] = [];
  for (const p of pages) {
    chunkText(p.text, opts).forEach((text, i) => {
      entries.push({
        id: `${meta.sourceFile}::p${p.page}::c${i}`,
        text,
        metadata: { text, title: meta.title, page: p.page, source_file: meta.sourceFile },
      });
    });
  }
  return entries;
}

/**
 * Chunk pages, embed the chunk texts (via the injected `embed` fn), and pair
 * them into Vectorize-ready records. `embed` is injected so this stays unit
 * testable without hitting OpenAI.
 */
export async function buildVectorRecords(
  pages: PdfPage[],
  meta: PaperMeta,
  embed: (texts: string[]) => Promise<number[][]>,
  opts?: ChunkOptions,
): Promise<VectorRecord[]> {
  const entries = chunksFromPages(pages, meta, opts);
  if (entries.length === 0) return [];
  const vectors = await embed(entries.map((e) => e.text));
  return entries.map((e, i) => ({ id: e.id, values: vectors[i], metadata: e.metadata }));
}
