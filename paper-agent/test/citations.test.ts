import { describe, it, expect } from "vitest";
import { extractCitations } from "../src/citations";
import type { RetrievedContext } from "../src/types";

function ctx(title: string, page: number): RetrievedContext {
  return { title, page, text: "…", sourceFile: "f.pdf", score: 0.5 };
}

describe("extractCitations", () => {
  it("dedupes by title + page, preserving first-seen order", () => {
    const contexts = [
      ctx("Lynch (2024)", 10),
      ctx("Qiang et al. (2022)", 5),
      ctx("Lynch (2024)", 10), // dup
      ctx("Lynch (2024)", 13), // same title, different page → kept
      ctx("Qiang et al. (2022)", 5), // dup
    ];
    expect(extractCitations(contexts)).toEqual([
      { title: "Lynch (2024)", page: 10 },
      { title: "Qiang et al. (2022)", page: 5 },
      { title: "Lynch (2024)", page: 13 },
    ]);
  });

  it("returns [] for no contexts", () => {
    expect(extractCitations([])).toEqual([]);
  });
});
