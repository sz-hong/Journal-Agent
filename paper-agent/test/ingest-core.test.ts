import { describe, it, expect } from "vitest";
import { chunksFromPages, buildVectorRecords } from "../src/ingest-core";
import type { PdfPage } from "../src/types";

const LONG_FILENAME =
  "A_Systematic_Review_of_Facial_Recognition_Methods_Advancements_Applications_and_Ethical_Dilemmas.pdf";

const pages: PdfPage[] = [
  { page: 1, text: "alpha ".repeat(50).trim() },
  { page: 2, text: "beta ".repeat(50).trim() },
];

const META = { sourceFile: LONG_FILENAME, title: "T", sessionId: "sess-a" };

describe("chunksFromPages", () => {
  it("keeps every id within Vectorize's 64-byte limit, even for long filenames", () => {
    const entries = chunksFromPages(pages, META);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(new TextEncoder().encode(e.id).length).toBeLessThanOrEqual(64);
    }
  });

  it("produces stable ids for the same input", () => {
    const a = chunksFromPages(pages, META);
    const b = chunksFromPages(pages, META);
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id));
  });

  it("produces distinct ids across pages, chunks, and different files", () => {
    const a = chunksFromPages(pages, META);
    const b = chunksFromPages(pages, { ...META, sourceFile: "other.pdf" });
    const all = [...a, ...b].map((e) => e.id);
    expect(new Set(all).size).toBe(all.length);
  });

  it("gives the same file different ids in different sessions (no cross-session overwrite)", () => {
    const a = chunksFromPages(pages, META);
    const b = chunksFromPages(pages, { ...META, sessionId: "sess-b" });
    for (let i = 0; i < a.length; i++) expect(a[i].id).not.toBe(b[i].id);
  });

  it("stamps session_id, source_file, and page into metadata", () => {
    const entries = chunksFromPages(pages, META);
    expect(entries[0].metadata.session_id).toBe("sess-a");
    expect(entries[0].metadata.source_file).toBe(LONG_FILENAME);
    expect(entries[0].metadata.page).toBe(1);
  });
});

describe("buildVectorRecords", () => {
  it("pairs each chunk with its embedding under the same id rules", async () => {
    const embed = async (texts: string[]) => texts.map(() => [0.1, 0.2]);
    const records = await buildVectorRecords(pages, META, embed);
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect(new TextEncoder().encode(r.id).length).toBeLessThanOrEqual(64);
      expect(r.values).toEqual([0.1, 0.2]);
      expect(r.metadata.session_id).toBe("sess-a");
    }
  });
});
