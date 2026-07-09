/** Text chunking, ported from the Python ingest (CHUNK_SIZE=1000, OVERLAP=200). */

export interface ChunkOptions {
  /** Target characters per chunk. */
  size?: number;
  /** Characters shared between adjacent chunks (must be < size). */
  overlap?: number;
  /** Drop chunks whose trimmed length is below this. */
  minChars?: number;
}

const DEFAULTS = { size: 1000, overlap: 200, minChars: 50 };

/**
 * Normalize whitespace, then split `text` into overlapping fixed-size windows.
 * Chunks shorter than `minChars` (after trim) are dropped, so tiny/empty
 * inputs yield `[]`.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const size = opts.size ?? DEFAULTS.size;
  const overlap = opts.overlap ?? DEFAULTS.overlap;
  const minChars = opts.minChars ?? DEFAULTS.minChars;

  const normalized = text.trim().split(/\s+/).join(" ");
  if (!normalized) return [];

  const step = Math.max(1, size - overlap);
  const chunks: string[] = [];
  for (let start = 0; start < normalized.length; start += step) {
    const chunk = normalized.slice(start, start + size);
    chunks.push(chunk);
    if (start + size >= normalized.length) break;
  }

  return chunks.filter((c) => c.trim().length >= minChars);
}
