import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../src/types";

// Mock the PDF parser so /ingest tests don't need a real PDF / pdfjs.
vi.mock("../src/pdf", () => ({ extractPdfPages: vi.fn() }));
import { extractPdfPages } from "../src/pdf";
import app from "../src/index";

const matches = [
  {
    id: "laws.pdf::p10::c0",
    score: 0.71,
    metadata: { text: "EU AI Act regulates live FRT.", title: "Lynch (2024)", page: 10, source_file: "laws.pdf" },
  },
  {
    id: "bio.pdf::p5::c2",
    score: 0.63,
    metadata: { text: "Cushing accuracy 95.93%.", title: "Qiang et al. (2022)", page: 5, source_file: "bio.pdf" },
  },
];

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function jsonResponse(o: unknown) {
  return new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
}

/** Fetch mock that answers OpenAI embeddings + chat by URL, respecting input length. */
function installOpenAiMock(answer = "mocked answer") {
  const fn = vi.fn(async (url: any, init: any) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : {};
    if (u.includes("/embeddings")) {
      const inputs: string[] = body.input;
      return jsonResponse({ data: inputs.map(() => ({ embedding: [0.1, 0.2, 0.3] })) });
    }
    if (u.includes("/chat/completions")) {
      return jsonResponse({ choices: [{ message: { role: "assistant", content: answer } }] });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    OPENAI_API_KEY: "sk-test",
    OPENAI_EMBED_MODEL: "text-embedding-3-small",
    OPENAI_CHAT_MODEL: "gpt-4o-mini",
    VECTORIZE: {
      query: vi.fn(async () => ({ count: matches.length, matches })),
      upsert: vi.fn(async () => ({ mutationId: "m1" })),
    },
    PAPERS_KV: {
      list: vi.fn(async () => ({
        keys: [{ name: "laws.pdf", metadata: { title: "Lynch (2024)" } }],
        list_complete: true,
      })),
      put: vi.fn(async () => {}),
      get: vi.fn(async () => null),
    },
    ASSETS: { fetch: vi.fn(async () => new Response("<html>ui</html>", { headers: { "content-type": "text/html" } })) },
    ...overrides,
  } as unknown as Env;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("POST /chat", () => {
  it("embeds the question, retrieves contexts, and returns a grounded answer with citations", async () => {
    installOpenAiMock("The EU AI Act restricts live FRT.");
    const env = makeEnv();
    const req = new Request("http://x/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "What does the EU AI Act say?" }),
    });

    const res = await app.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;

    expect(data.answer).toBe("The EU AI Act restricts live FRT.");
    expect((env.VECTORIZE.query as any)).toHaveBeenCalledTimes(1);
    expect(data.citations).toEqual([
      { title: "Lynch (2024)", page: 10 },
      { title: "Qiang et al. (2022)", page: 5 },
    ]);
  });

  it("400s when message is missing", async () => {
    installOpenAiMock();
    const res = await app.fetch(
      new Request("http://x/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /papers", () => {
  it("lists ingested papers from KV", async () => {
    const res = await app.fetch(new Request("http://x/papers"), makeEnv(), ctx);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.papers).toEqual([{ file: "laws.pdf", title: "Lynch (2024)" }]);
  });
});

describe("POST /ingest", () => {
  it("parses an uploaded PDF, embeds chunks, upserts to Vectorize, and records it in KV", async () => {
    installOpenAiMock();
    (extractPdfPages as any).mockResolvedValue([{ page: 1, text: "x".repeat(300) }]);
    const env = makeEnv();

    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3])], "newpaper.pdf", { type: "application/pdf" }));
    const res = await app.fetch(new Request("http://x/ingest", { method: "POST", body: form }), env, ctx);

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.added).toBeGreaterThan(0);
    expect(data.title).toBe("newpaper");

    expect((env.VECTORIZE.upsert as any)).toHaveBeenCalledTimes(1);
    const upserted = (env.VECTORIZE.upsert as any).mock.calls[0][0];
    expect(upserted).toHaveLength(data.added);
    expect(upserted[0]).toHaveProperty("values");
    expect(upserted[0].metadata.source_file).toBe("newpaper.pdf");
    expect((env.PAPERS_KV.put as any)).toHaveBeenCalledWith(
      "newpaper.pdf",
      "newpaper",
      { metadata: { title: "newpaper" } },
    );
  });

  it("422s when the PDF has no extractable text", async () => {
    installOpenAiMock();
    (extractPdfPages as any).mockResolvedValue([{ page: 1, text: "" }]);
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1])], "empty.pdf", { type: "application/pdf" }));
    const res = await app.fetch(new Request("http://x/ingest", { method: "POST", body: form }), makeEnv(), ctx);
    expect(res.status).toBe(422);
  });
});
