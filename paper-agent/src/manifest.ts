import type { PaperManifest } from "./types";

/**
 * Parse a KV manifest value. Values written since the summary/delete features
 * are JSON ({title, summary, chunkIds}); older entries were the plain title
 * string, and a missing value falls back to the file name.
 */
export function parseManifest(raw: string | null, fileName: string): PaperManifest {
  if (raw == null || raw === "") {
    return { title: fileName, summary: "", chunkIds: [] };
  }
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && typeof obj.title === "string") {
      return {
        title: obj.title,
        summary: typeof obj.summary === "string" ? obj.summary : "",
        chunkIds: Array.isArray(obj.chunkIds) ? obj.chunkIds : [],
      };
    }
  } catch {
    // not JSON → legacy plain-title value
  }
  return { title: raw, summary: "", chunkIds: [] };
}
