import { describe, it, expect, vi, afterEach } from "vitest";
import { toolDefinitions, executeTool } from "../src/tools";
import type { Env } from "../src/types";

const SID = "11111111-aaaa-bbbb-cccc-222222222222";

const CARD = {
  overview: "本文提出人臉辨識新法。",
  why: "遮擋問題重要。",
  how: "CNN + LFW。",
  what: "準確率 99.2%。",
  limitations: "未測跨種族偏差。",
  generatedAt: 1,
};

const MANIFESTS: Record<string, string> = {
  [`s:${SID}:paper:laws.pdf`]: JSON.stringify({
    title: "Lynch (2024)",
    summary: "監管概述。",
    chunkIds: ["a"],
    card: CARD,
  }),
  [`s:${SID}:paper:bio.pdf`]: JSON.stringify({
    title: "Qiang et al. (2022)",
    summary: "疾病診斷應用。",
    chunkIds: ["b"],
  }),
};

const matches = [
  {
    id: "x::p10::c0",
    score: 0.71,
    metadata: {
      text: "EU AI Act regulates live FRT.",
      title: "Lynch (2024)",
      page: 10,
      source_file: "laws.pdf",
      session_id: SID,
    },
  },
  {
    id: "y::p5::c2",
    score: 0.63,
    metadata: {
      text: "Cushing accuracy 95.93%.",
      title: "Qiang et al. (2022)",
      page: 5,
      source_file: "bio.pdf",
      session_id: SID,
    },
  },
];

function makeEnv() {
  return {
    OPENAI_API_KEY: "sk-test",
    OPENAI_EMBED_MODEL: "text-embedding-3-small",
    OPENAI_CHAT_MODEL: "gpt-4o-mini",
    VECTORIZE: { query: vi.fn(async () => ({ count: matches.length, matches })) },
    PAPERS_KV: {
      get: vi.fn(async (key: string) => MANIFESTS[key] ?? null),
      list: vi.fn(async ({ prefix = "" }: { prefix?: string } = {}) => ({
        keys: Object.keys(MANIFESTS)
          .filter((k) => k.startsWith(prefix))
          .map((name) => ({ name })),
        list_complete: true,
      })),
    },
  } as unknown as Env;
}

function stubEmbeddings() {
  const fn = vi.fn(async (_url?: unknown, _init?: unknown) =>
    new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("toolDefinitions", () => {
  it("declares the three tools with an English-keyword instruction on the search query", () => {
    const names = toolDefinitions.map((t) => t.function.name);
    expect(names).toEqual(["list_papers", "get_paper_card", "search_passages"]);
    const search = toolDefinitions.find((t) => t.function.name === "search_passages")!;
    const queryDesc = (search.function.parameters as any).properties.query.description as string;
    expect(queryDesc).toMatch(/English keywords/);
  });
});

describe("executeTool: list_papers", () => {
  it("lists every paper with its number, file, title, and overview", async () => {
    const res = await executeTool(makeEnv(), SID, "list_papers", "{}");
    expect(res.content).toContain("laws.pdf");
    expect(res.content).toContain("Lynch (2024)");
    expect(res.content).toContain(CARD.overview);
    expect(res.content).toContain("bio.pdf");
    expect(res.content).toContain("疾病診斷應用。");
    // stable numbering by file-name order: bio.pdf → 論文1, laws.pdf → 論文2
    expect(res.content).toContain("論文1");
    expect(res.content).toContain("論文2");
  });
});

describe("executeTool: get_paper_card", () => {
  it("returns the structured card fields for a paper that has one", async () => {
    const res = await executeTool(makeEnv(), SID, "get_paper_card", JSON.stringify({ file: "laws.pdf" }));
    expect(res.content).toContain("Lynch (2024)");
    expect(res.content).toContain(CARD.why);
    expect(res.content).toContain(CARD.how);
    expect(res.content).toContain(CARD.what);
    expect(res.content).toContain(CARD.limitations);
  });

  it("falls back to the summary for a paper without a card", async () => {
    const res = await executeTool(makeEnv(), SID, "get_paper_card", JSON.stringify({ file: "bio.pdf" }));
    expect(res.content).toContain("疾病診斷應用。");
    expect(res.content).toContain("尚無結構化卡片");
  });

  it("errors (without throwing) on an unknown file, naming the available ones", async () => {
    const res = await executeTool(makeEnv(), SID, "get_paper_card", JSON.stringify({ file: "nope.pdf" }));
    expect(res.content).toMatch(/error/i);
    expect(res.content).toContain("laws.pdf");
  });
});

describe("executeTool: search_passages", () => {
  it("embeds the query, searches the session, and returns passages labeled with paper numbers", async () => {
    stubEmbeddings();
    const env = makeEnv();
    const res = await executeTool(env, SID, "search_passages", JSON.stringify({ query: "EU AI act regulation" }));
    // laws.pdf is 論文2 in file-name order; passages carry (論文N, p.X) labels
    expect(res.content).toContain("(論文2, p.10)");
    expect(res.content).toContain("EU AI Act regulates live FRT.");
    expect(res.contexts).toHaveLength(2);
    // contexts carry the paper number for citation chips
    expect(res.contexts!.find((c) => c.sourceFile === "laws.pdf")!.n).toBe(2);
    expect(res.contexts!.find((c) => c.sourceFile === "bio.pdf")!.n).toBe(1);
    const opts = (env.VECTORIZE.query as any).mock.calls[0][1];
    expect(opts.topK).toBe(8);
    expect(opts.filter).toEqual({ session_id: SID });
  });

  it("scopes to one paper via post-filtering with a larger topK", async () => {
    stubEmbeddings();
    const env = makeEnv();
    const res = await executeTool(
      env,
      SID,
      "search_passages",
      JSON.stringify({ query: "regulation", file: "laws.pdf" }),
    );
    expect(res.contexts!.every((c) => c.sourceFile === "laws.pdf")).toBe(true);
    expect(res.content).not.toContain("Cushing");
    expect((env.VECTORIZE.query as any).mock.calls[0][1].topK).toBe(12);
  });

  it("rejects a mostly-Chinese query before embedding (model must rewrite in English)", async () => {
    const fetchMock = stubEmbeddings();
    const res = await executeTool(
      makeEnv(),
      SID,
      "search_passages",
      JSON.stringify({ query: "人臉辨識的法規" }),
    );
    expect(res.content).toMatch(/English keywords/);
    expect(res.contexts).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("errors on an empty query and an unknown scoping file", async () => {
    stubEmbeddings();
    let res = await executeTool(makeEnv(), SID, "search_passages", JSON.stringify({ query: " " }));
    expect(res.content).toMatch(/error/i);
    res = await executeTool(
      makeEnv(),
      SID,
      "search_passages",
      JSON.stringify({ query: "regulation", file: "nope.pdf" }),
    );
    expect(res.content).toMatch(/error/i);
    expect(res.content).toContain("laws.pdf");
  });
});

describe("executeTool: robustness", () => {
  it("returns error strings for malformed JSON args and unknown tools", async () => {
    let res = await executeTool(makeEnv(), SID, "search_passages", "{not json");
    expect(res.content).toMatch(/error/i);
    res = await executeTool(makeEnv(), SID, "made_up_tool", "{}");
    expect(res.content).toMatch(/error/i);
  });
});
