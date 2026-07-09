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

const LAWS_MANIFEST = JSON.stringify({
  title: "Lynch (2024)",
  summary: "本文探討人臉辨識監管。",
  chunkIds: ["h1::p1::c0", "h1::p2::c0"],
});

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function jsonResponse(o: unknown) {
  return new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * Fetch mock covering every OpenAI call the Worker makes, dispatched by URL,
 * system-prompt marker, and stream flag:
 *  - embeddings → fixed vectors
 *  - planner chat (system mentions "vector-search queries") → JSON query array
 *  - summary chat (system mentions "摘要") → canned zh-Hant summary
 *  - answer chat, stream:true → SSE deltas; stream absent → JSON answer
 */
function installOpenAiMock(opts: { answer?: string; queries?: string[]; summary?: string } = {}) {
  const { answer = "mocked answer", queries = ["standalone query"], summary = "模擬摘要" } = opts;
  const fn = vi.fn(async (url: any, init: any) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : {};
    if (u.includes("/embeddings")) {
      const inputs: string[] = body.input;
      return jsonResponse({ data: inputs.map(() => ({ embedding: [0.1, 0.2, 0.3] })) });
    }
    if (u.includes("/chat/completions")) {
      const sys: string = body.messages?.[0]?.content ?? "";
      if (sys.includes("vector-search queries")) {
        return jsonResponse({ choices: [{ message: { role: "assistant", content: JSON.stringify(queries) } }] });
      }
      if (sys.includes("摘要")) {
        return jsonResponse({ choices: [{ message: { role: "assistant", content: summary } }] });
      }
      if (body.stream) {
        const enc = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: answer.slice(0, 3) } }] })}\n\n`));
            c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: answer.slice(3) } }] })}\n\n`));
            c.enqueue(enc.encode("data: [DONE]\n\n"));
            c.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
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
      deleteByIds: vi.fn(async () => ({ mutationId: "m2" })),
    },
    PAPERS_KV: {
      list: vi.fn(async () => ({
        keys: [{ name: "laws.pdf", metadata: { title: "Lynch (2024)" } }],
        list_complete: true,
      })),
      put: vi.fn(async () => {}),
      get: vi.fn(async (key: string) => (key === "laws.pdf" ? LAWS_MANIFEST : null)),
      delete: vi.fn(async () => {}),
    },
    ASSETS: { fetch: vi.fn(async () => new Response("<html>ui</html>", { headers: { "content-type": "text/html" } })) },
    ...overrides,
  } as unknown as Env;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("POST /chat (stream:false)", () => {
  it("plans queries, retrieves per query, merges, and returns a grounded answer with citations", async () => {
    installOpenAiMock({
      answer: "The EU AI Act restricts live FRT.",
      queries: ["EU AI Act live FRT", "Cushing diagnosis accuracy"],
    });
    const env = makeEnv();
    const req = new Request("http://x/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "What does the EU AI Act say?", stream: false }),
    });

    const res = await app.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;

    expect(data.answer).toBe("The EU AI Act restricts live FRT.");
    // one Vectorize query per planned search query
    expect((env.VECTORIZE.query as any)).toHaveBeenCalledTimes(2);
    expect(data.queries).toEqual(["EU AI Act live FRT", "Cushing diagnosis accuracy"]);
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
        body: JSON.stringify({ stream: false }),
      }),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /chat (SSE default)", () => {
  it("streams meta, delta, and done events", async () => {
    installOpenAiMock({ answer: "Streamed!" });
    const env = makeEnv();
    const res = await app.fetch(
      new Request("http://x/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "q" }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();

    // meta first (citations available before generation), then deltas, then done
    const metaIdx = text.indexOf("event: meta");
    const deltaIdx = text.indexOf("event: delta");
    const doneIdx = text.indexOf("event: done");
    expect(metaIdx).toBeGreaterThanOrEqual(0);
    expect(deltaIdx).toBeGreaterThan(metaIdx);
    expect(doneIdx).toBeGreaterThan(deltaIdx);

    expect(text).toContain('"title":"Lynch (2024)"');
    // the two deltas reassemble the full answer
    expect(text).toContain('{"text":"Str"}');
    expect(text).toContain('{"text":"eamed!"}');
  });
});

describe("GET /papers", () => {
  it("lists ingested papers with summaries from the KV manifest", async () => {
    const res = await app.fetch(new Request("http://x/papers"), makeEnv(), ctx);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.papers).toEqual([
      { file: "laws.pdf", title: "Lynch (2024)", summary: "本文探討人臉辨識監管。" },
    ]);
  });

  it("tolerates legacy plain-string manifests", async () => {
    const env = makeEnv();
    (env.PAPERS_KV.get as any).mockResolvedValue("Old Title");
    const res = await app.fetch(new Request("http://x/papers"), env, ctx);
    const data = (await res.json()) as any;
    expect(data.papers[0]).toEqual({ file: "laws.pdf", title: "Old Title", summary: "" });
  });
});

describe("POST /ingest", () => {
  it("parses, embeds, upserts, summarizes, and records the JSON manifest", async () => {
    installOpenAiMock({ summary: "這篇論文的自動摘要。" });
    (extractPdfPages as any).mockResolvedValue([{ page: 1, text: "x".repeat(300) }]);
    const env = makeEnv();

    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3])], "newpaper.pdf", { type: "application/pdf" }));
    const res = await app.fetch(new Request("http://x/ingest", { method: "POST", body: form }), env, ctx);

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.added).toBeGreaterThan(0);
    expect(data.title).toBe("newpaper");
    expect(data.summary).toBe("這篇論文的自動摘要。");

    const upserted = (env.VECTORIZE.upsert as any).mock.calls[0][0];
    expect(upserted).toHaveLength(data.added);

    // KV value is the JSON manifest carrying summary + chunk ids for delete
    const [key, value, opts] = (env.PAPERS_KV.put as any).mock.calls[0];
    expect(key).toBe("newpaper.pdf");
    const manifest = JSON.parse(value);
    expect(manifest.title).toBe("newpaper");
    expect(manifest.summary).toBe("這篇論文的自動摘要。");
    expect(manifest.chunkIds).toHaveLength(data.added);
    expect(opts).toEqual({ metadata: { title: "newpaper" } });
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

describe("DELETE /papers/:file", () => {
  it("deletes the paper's vectors by chunk id and removes the KV entry", async () => {
    const env = makeEnv();
    const res = await app.fetch(new Request("http://x/papers/laws.pdf", { method: "DELETE" }), env, ctx);

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data).toEqual({ deleted: "laws.pdf", removedChunks: 2 });
    expect((env.VECTORIZE as any).deleteByIds).toHaveBeenCalledWith(["h1::p1::c0", "h1::p2::c0"]);
    expect((env.PAPERS_KV.delete as any)).toHaveBeenCalledWith("laws.pdf");
  });

  it("404s for a paper that is not in the manifest", async () => {
    const res = await app.fetch(new Request("http://x/papers/nope.pdf", { method: "DELETE" }), makeEnv(), ctx);
    expect(res.status).toBe(404);
  });

  it("409s for legacy entries with no recorded chunk ids", async () => {
    const env = makeEnv();
    (env.PAPERS_KV.get as any).mockResolvedValue("Old Title");
    const res = await app.fetch(new Request("http://x/papers/laws.pdf", { method: "DELETE" }), env, ctx);
    expect(res.status).toBe(409);
    expect((env.PAPERS_KV.delete as any)).not.toHaveBeenCalled();
  });
});
