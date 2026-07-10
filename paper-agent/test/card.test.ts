import { describe, it, expect, vi, afterEach } from "vitest";
import { buildBatches, parseCard, generatePaperCard } from "../src/card";
import type { Env, PdfPage } from "../src/types";

const env = {
  OPENAI_API_KEY: "sk-test",
  OPENAI_CHAT_MODEL: "gpt-4o-mini",
} as unknown as Env;

const CARD_JSON = {
  overview: "本文提出一種人臉辨識方法。",
  why: "現有方法在遮擋下表現差。",
  how: "以 CNN 搭配 LFW 資料集訓練。",
  what: "準確率達 99.2%。",
  limitations: "未評估跨種族偏差。",
};

/** Stub fetch with a handler that maps (system prompt, parsed body) → reply text. */
function installFetch(handler: (sys: string, body: any) => string) {
  const fn = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse((init as RequestInit).body as string);
    const sys = body.messages[0].content as string;
    const content = handler(sys, body);
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("buildBatches", () => {
  it("packs pages into batches no longer than the limit", () => {
    const pages: PdfPage[] = Array.from({ length: 10 }, (_, i) => ({
      page: i + 1,
      text: `page ${i + 1} content. `.repeat(50),
    }));
    const batches = buildBatches(pages, 3000);
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) expect(b.length).toBeLessThanOrEqual(3000);
    expect(batches[0]).toContain("[p.1]");
  });

  it("caps at 8 batches keeping the head and the final batch (conclusion survives)", () => {
    const pages: PdfPage[] = Array.from({ length: 40 }, (_, i) => ({
      page: i + 1,
      text: `page ${i + 1} body. `.repeat(200), // ~3000 chars each → ~10 raw batches at 12000
    }));
    const batches = buildBatches(pages);
    expect(batches.length).toBeLessThanOrEqual(8);
    expect(batches[0]).toContain("[p.1]");
    expect(batches[batches.length - 1]).toContain("[p.40]");
  });

  it("returns no batches for empty or whitespace-only pages", () => {
    expect(buildBatches([])).toEqual([]);
    expect(buildBatches([{ page: 1, text: "   " }])).toEqual([]);
  });
});

describe("parseCard", () => {
  it("accepts a full card and stamps generatedAt", () => {
    const card = parseCard(CARD_JSON);
    expect(card?.overview).toBe(CARD_JSON.overview);
    expect(card?.limitations).toBe(CARD_JSON.limitations);
    expect(typeof card?.generatedAt).toBe("number");
  });

  it("keeps an existing numeric generatedAt (stored manifests round-trip)", () => {
    const card = parseCard({ ...CARD_JSON, generatedAt: 12345 });
    expect(card?.generatedAt).toBe(12345);
  });

  it("rejects non-objects, missing fields, and non-string fields", () => {
    expect(parseCard(null)).toBeUndefined();
    expect(parseCard("text")).toBeUndefined();
    expect(parseCard([CARD_JSON])).toBeUndefined();
    const { limitations: _drop, ...missing } = CARD_JSON;
    expect(parseCard(missing)).toBeUndefined();
    expect(parseCard({ ...CARD_JSON, what: 42 })).toBeUndefined();
  });
});

describe("generatePaperCard", () => {
  const shortPages: PdfPage[] = [
    { page: 1, text: "Abstract: we study face recognition under occlusion." },
    { page: 2, text: "Method: CNN trained on LFW. Accuracy 99.2%." },
  ];

  it("short paper: single reduce call, no map phase", async () => {
    const fetchMock = installFetch((sys) => {
      expect(sys).toContain("結構化卡片");
      return JSON.stringify(CARD_JSON);
    });
    const card = await generatePaperCard(env, "Occlusion FR", shortPages);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(card?.what).toBe(CARD_JSON.what);
    // the reduce call sees the title and the raw paper text
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const user = body.messages.find((m: any) => m.role === "user").content as string;
    expect(user).toContain("Occlusion FR");
    expect(user).toContain("face recognition under occlusion");
  });

  it("long paper: one map call per batch plus a reduce fed with the map notes", async () => {
    const longPages: PdfPage[] = Array.from({ length: 12 }, (_, i) => ({
      page: i + 1,
      text: `section ${i + 1}. `.repeat(400), // ~4400 chars each → several 12000-char batches
    }));
    let mapCalls = 0;
    const fetchMock = installFetch((sys) => {
      if (sys.includes("逐段筆記")) {
        mapCalls += 1;
        return `筆記片段 ${mapCalls}`;
      }
      expect(sys).toContain("結構化卡片");
      return JSON.stringify(CARD_JSON);
    });
    const card = await generatePaperCard(env, "Long Survey", longPages);
    expect(card).not.toBeNull();
    expect(mapCalls).toBeGreaterThan(1);
    expect(fetchMock).toHaveBeenCalledTimes(mapCalls + 1);
    // reduce input carries every map note
    const reduceBody = JSON.parse(
      (fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1] as RequestInit).body as string,
    );
    const reduceUser = reduceBody.messages.find((m: any) => m.role === "user").content as string;
    expect(reduceUser).toContain("筆記片段 1");
    expect(reduceUser).toContain(`筆記片段 ${mapCalls}`);
  });

  it("parses a ```json fenced reply", async () => {
    installFetch(() => "```json\n" + JSON.stringify(CARD_JSON) + "\n```");
    const card = await generatePaperCard(env, "T", shortPages);
    expect(card?.overview).toBe(CARD_JSON.overview);
  });

  it("returns null on unparseable output and on request failure (never throws)", async () => {
    installFetch(() => "這不是 JSON");
    expect(await generatePaperCard(env, "T", shortPages)).toBeNull();

    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    expect(await generatePaperCard(env, "T", shortPages)).toBeNull();
  });

  it("returns null for a paper with no extractable text", async () => {
    const fetchMock = installFetch(() => JSON.stringify(CARD_JSON));
    expect(await generatePaperCard(env, "T", [{ page: 1, text: " " }])).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
