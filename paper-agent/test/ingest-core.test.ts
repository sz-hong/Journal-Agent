import { describe, it, expect } from "vitest";
import { chunksFromPages, buildVectorRecords } from "../src/ingest-core";
import type { PdfPage } from "../src/types";

const LONG_FILENAME =
  "A_Systematic_Review_of_Facial_Recognition_Methods_Advancements_Applications_and_Ethical_Dilemmas.pdf";

const pages: PdfPage[] = [
  { page: 1, text: "alpha ".repeat(50).trim() },
  { page: 2, text: "beta ".repeat(50).trim() },
];

describe("chunksFromPages", () => {
  it("keeps every id within Vectorize's 64-byte limit, even for long filenames", () => {
    const entries = chunksFromPages(pages, { sourceFile: LONG_FILENAME, title: "T" });
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(new TextEncoder().encode(e.id).length).toBeLessThanOrEqual(64);
    }
  });

  it("produces stable ids for the same input", () => {
    const a = chunksFromPages(pages, { sourceFile: LONG_FILENAME, title: "T" });
    const b = chunksFromPages(pages, { sourceFile: LONG_FILENAME, title: "T" });
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id));
  });

  it("produces distinct ids across pages, chunks, and different files", () => {
    const a = chunksFromPages(pages, { sourceFile: LONG_FILENAME, title: "T" });
    const b = chunksFromPages(pages, { sourceFile: "other.pdf", title: "T" });
    const all = [...a, ...b].map((e) => e.id);
    expect(new Set(all).size).toBe(all.length);
  });

  it("keeps full source_file and page in metadata (citations unaffected by id hashing)", () => {
    const entries = chunksFromPages(pages, { sourceFile: LONG_FILENAME, title: "T" });
    expect(entries[0].metadata.source_file).toBe(LONG_FILENAME);
    expect(entries[0].metadata.page).toBe(1);
  });
});

describe("buildVectorRecords", () => {
  it("pairs each chunk with its embedding under the same id rules", async () => {
    const embed = async (texts: string[]) => texts.map(() => [0.1, 0.2]);
    const records = await buildVectorRecords(pages, { sourceFile: LONG_FILENAME, title: "T" }, embed);
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect(new TextEncoder().encode(r.id).length).toBeLessThanOrEqual(64);
      expect(r.values).toEqual([0.1, 0.2]);
    }
  });
});
