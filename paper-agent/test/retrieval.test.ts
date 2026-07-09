import { describe, it, expect, vi } from "vitest";
import { matchesToContexts, queryContexts, mergeContexts } from "../src/retrieval";
import type { Env, RetrievedContext } from "../src/types";

const matches = [
  {
    id: "laws.pdf::p10::c0",
    score: 0.71,
    metadata: { text: "EU AI Act text", title: "Lynch (2024)", page: 10, source_file: "laws.pdf" },
  },
  {
    id: "bio.pdf::p5::c2",
    score: 0.63,
    metadata: { text: "Cushing 95.93%", title: "Qiang et al. (2022)", page: 5, source_file: "bio.pdf" },
  },
];

describe("matchesToContexts", () => {
  it("maps Vectorize matches to RetrievedContext (score + metadata)", () => {
    expect(matchesToContexts(matches as any)).toEqual([
      { text: "EU AI Act text", title: "Lynch (2024)", page: 10, sourceFile: "laws.pdf", score: 0.71 },
      { text: "Cushing 95.93%", title: "Qiang et al. (2022)", page: 5, sourceFile: "bio.pdf", score: 0.63 },
    ]);
  });

  it("skips matches that have no metadata text", () => {
    const partial = [{ id: "x", score: 0.9 }, ...matches];
    expect(matchesToContexts(partial as any)).toHaveLength(2);
  });
});

describe("mergeContexts", () => {
  const ctx = (text: string, score: number, page = 1, sourceFile = "a.pdf"): RetrievedContext => ({
    text,
    title: "T",
    page,
    sourceFile,
    score,
  });

  it("dedupes identical chunks retrieved by different queries, keeping the best score", () => {
    const merged = mergeContexts([
      [ctx("same chunk", 0.5)],
      [ctx("same chunk", 0.8), ctx("other chunk", 0.6)],
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ text: "same chunk", score: 0.8 });
  });

  it("sorts by score descending", () => {
    const merged = mergeContexts([[ctx("low", 0.2), ctx("high", 0.9)], [ctx("mid", 0.5, 2)]]);
    expect(merged.map((c) => c.text)).toEqual(["high", "mid", "low"]);
  });

  it("caps the merged list", () => {
    const many = Array.from({ length: 12 }, (_, i) => ctx(`chunk ${i}`, i / 100, i));
    expect(mergeContexts([many], 8)).toHaveLength(8);
  });
});

describe("queryContexts", () => {
  it("queries the Vectorize binding with topK + metadata and maps the result", async () => {
    const query = vi.fn(async (_vec?: unknown, _opts?: unknown) => ({ count: matches.length, matches }));
    const env = { VECTORIZE: { query } } as unknown as Env;

    const out = await queryContexts(env, [0.1, 0.2, 0.3], 5);

    expect(query).toHaveBeenCalledTimes(1);
    const [vec, opts] = query.mock.calls[0];
    expect(vec).toEqual([0.1, 0.2, 0.3]);
    expect((opts as any).topK).toBe(5);
    expect((opts as any).returnMetadata).toBeTruthy();
    expect(out).toHaveLength(2);
    expect(out[0].title).toBe("Lynch (2024)");
  });
});
