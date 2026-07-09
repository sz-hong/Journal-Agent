import { describe, it, expect, vi } from "vitest";
import { matchesToContexts, queryContexts } from "../src/retrieval";
import type { Env } from "../src/types";

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
