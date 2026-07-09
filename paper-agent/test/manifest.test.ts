import { describe, it, expect } from "vitest";
import { parseManifest } from "../src/manifest";

describe("parseManifest", () => {
  it("parses the JSON manifest format", () => {
    const raw = JSON.stringify({ title: "T", summary: "S", chunkIds: ["a::p1::c0"] });
    expect(parseManifest(raw, "f.pdf")).toEqual({ title: "T", summary: "S", chunkIds: ["a::p1::c0"] });
  });

  it("treats a legacy plain-string value as the title with no summary/chunkIds", () => {
    expect(parseManifest("Lynch (2024)", "laws.pdf")).toEqual({
      title: "Lynch (2024)",
      summary: "",
      chunkIds: [],
    });
  });

  it("falls back to the file name when the value is null", () => {
    expect(parseManifest(null, "x.pdf")).toEqual({ title: "x.pdf", summary: "", chunkIds: [] });
  });

  it("fills missing fields when the JSON is partial", () => {
    expect(parseManifest(JSON.stringify({ title: "T" }), "f.pdf")).toEqual({
      title: "T",
      summary: "",
      chunkIds: [],
    });
  });
});
