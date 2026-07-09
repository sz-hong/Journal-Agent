import { describe, it, expect } from "vitest";
import { chunkText } from "../src/chunk";

describe("chunkText", () => {
  it("returns [] for empty or whitespace-only input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\t  ")).toEqual([]);
  });

  it("normalizes internal whitespace before chunking", () => {
    const out = chunkText("hello   world\n\nfoo\tbar", { size: 100, minChars: 1 });
    expect(out).toEqual(["hello world foo bar"]);
  });

  it("splits long text into overlapping chunks with correct boundaries", () => {
    const text = "abcdefghijklmnopqrstuvwxy"; // 25 chars, no spaces
    const out = chunkText(text, { size: 10, overlap: 3, minChars: 1 });
    expect(out).toEqual([
      "abcdefghij", // [0:10]
      "hijklmnopq", // [7:17]
      "opqrstuvwx", // [14:24]
      "vwxy", // [21:25]
    ]);
  });

  it("makes every non-final chunk exactly `size` long (overlap = size - step)", () => {
    const text = "abcdefghijklmnopqrstuvwxy";
    const out = chunkText(text, { size: 10, overlap: 3, minChars: 1 });
    // second chunk starts at size - overlap = 7
    expect(out[1]).toBe(text.slice(7, 17));
    for (const c of out.slice(0, -1)) expect(c.length).toBe(10);
  });

  it("skips chunks shorter than minChars (default 50)", () => {
    // A short document is dropped entirely under the default threshold.
    expect(chunkText("short text under fifty chars")).toEqual([]);
    // ...but kept when minChars is lowered.
    expect(chunkText("short text", { minChars: 1 })).toEqual(["short text"]);
  });
});
