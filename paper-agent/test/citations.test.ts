import { describe, it, expect } from "vitest";
import { extractCitations, attachQuotes } from "../src/citations";
import type { RetrievedContext } from "../src/types";

function ctx(title: string, page: number, text = "…", score = 0.5): RetrievedContext {
  return { title, page, text, sourceFile: "f.pdf", score };
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

  it("carries the paper number through to citations when present", () => {
    const withN = { ...ctx("Lynch (2024)", 10), n: 2 };
    expect(extractCitations([withN])).toEqual([{ title: "Lynch (2024)", page: 10, n: 2 }]);
  });
});

describe("attachQuotes", () => {
  it("attaches the highest-scoring matching context text to each citation", () => {
    const contexts = [
      ctx("Lynch (2024)", 10, "low-score passage", 0.3),
      ctx("Lynch (2024)", 10, "best passage", 0.9),
      ctx("Qiang et al. (2022)", 5, "cushing passage", 0.6),
    ];
    const out = attachQuotes(extractCitations(contexts), contexts);
    expect(out[0]).toEqual({ title: "Lynch (2024)", page: 10, text: "best passage" });
    expect(out[1]).toEqual({ title: "Qiang et al. (2022)", page: 5, text: "cushing passage" });
  });

  it("leaves citations without a matching context untouched (no text field)", () => {
    const out = attachQuotes([{ title: "Ghost", page: 1 }], []);
    expect(out[0]).toEqual({ title: "Ghost", page: 1 });
    expect(out[0]).not.toHaveProperty("text");
  });

  it("truncates long quotes", () => {
    const long = "x".repeat(2000);
    const out = attachQuotes(
      [{ title: "T", page: 1 }],
      [ctx("T", 1, long, 0.9)],
      500,
    );
    expect(out[0].text!.length).toBeLessThanOrEqual(501); // 500 + ellipsis
  });
});
