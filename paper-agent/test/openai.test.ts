import { describe, it, expect, vi, afterEach } from "vitest";
import { embedTexts, embedQuery, chat, chatStream, chatStreamWithTools } from "../src/openai";
import type { StreamEvent } from "../src/openai";
import type { Env, ToolDefinition } from "../src/types";

const env = {
  OPENAI_API_KEY: "sk-test",
  OPENAI_EMBED_MODEL: "text-embedding-3-small",
  OPENAI_CHAT_MODEL: "gpt-4o-mini",
} as unknown as Env;

function mockFetch(payload: unknown, ok = true, status = 200) {
  const fn = vi.fn(async (_url?: unknown, _init?: unknown) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  // Response.ok is derived from status; ensure consistency
  void ok;
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("embedTexts", () => {
  it("POSTs to the embeddings endpoint with auth + model and returns vectors", async () => {
    const fetchMock = mockFetch({
      data: [
        { embedding: [0.1, 0.2] },
        { embedding: [0.3, 0.4] },
      ],
    });

    const vecs = await embedTexts(env, ["a", "b"]);
    expect(vecs).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.openai.com/v1/embeddings");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-test");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("text-embedding-3-small");
    expect(body.input).toEqual(["a", "b"]);
  });

  it("throws on a non-OK response", async () => {
    mockFetch({ error: { message: "bad key" } }, false, 401);
    await expect(embedTexts(env, ["a"])).rejects.toThrow(/401|bad key|OpenAI/i);
  });

  it("passes dimensions when OPENAI_EMBED_DIMENSIONS is set (e.g. 3-large truncated to 1536)", async () => {
    const fetchMock = mockFetch({ data: [{ embedding: [0.1] }] });
    const largeEnv = {
      ...env,
      OPENAI_EMBED_MODEL: "text-embedding-3-large",
      OPENAI_EMBED_DIMENSIONS: "1536",
    } as unknown as Env;

    await embedTexts(largeEnv, ["a"]);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.model).toBe("text-embedding-3-large");
    expect(body.dimensions).toBe(1536);
  });

  it("omits dimensions when OPENAI_EMBED_DIMENSIONS is unset", async () => {
    const fetchMock = mockFetch({ data: [{ embedding: [0.1] }] });
    await embedTexts(env, ["a"]);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).not.toHaveProperty("dimensions");
  });
});

describe("embedQuery", () => {
  it("returns a single vector for one string", async () => {
    mockFetch({ data: [{ embedding: [1, 2, 3] }] });
    expect(await embedQuery(env, "hello")).toEqual([1, 2, 3]);
  });
});

describe("chat", () => {
  it("POSTs messages to chat/completions and returns the content", async () => {
    const fetchMock = mockFetch({
      choices: [{ message: { role: "assistant", content: "the answer" } }],
    });

    const out = await chat(env, [{ role: "user", content: "q" }]);
    expect(out).toBe("the answer");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.openai.com/v1/chat/completions");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.messages).toEqual([{ role: "user", content: "q" }]);
  });

  it("sends temperature for gpt-4 family models", async () => {
    const fetchMock = mockFetch({ choices: [{ message: { content: "x" } }] });
    await chat(env, [{ role: "user", content: "q" }]);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.temperature).toBe(0.2);
  });

  it("omits temperature for gpt-5/o-series models (they reject non-default values)", async () => {
    const fetchMock = mockFetch({ choices: [{ message: { content: "x" } }] });
    const gpt5Env = { ...env, OPENAI_CHAT_MODEL: "gpt-5.4" } as unknown as Env;
    await chat(gpt5Env, [{ role: "user", content: "q" }]);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.model).toBe("gpt-5.4");
    expect(body).not.toHaveProperty("temperature");
  });
});

describe("AI Gateway routing", () => {
  it("uses OPENAI_BASE_URL and sends cf-aig-authorization when configured", async () => {
    const fetchMock = mockFetch({ data: [{ embedding: [0.1] }] });
    const gwEnv = {
      ...env,
      OPENAI_BASE_URL: "https://gateway.ai.cloudflare.com/v1/acct/journal-agent/openai",
      CF_AIG_TOKEN: "aig-secret",
    } as unknown as Env;

    await embedTexts(gwEnv, ["a"]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://gateway.ai.cloudflare.com/v1/acct/journal-agent/openai/embeddings");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["cf-aig-authorization"]).toBe("Bearer aig-secret");
    expect(headers["Authorization"]).toBe("Bearer sk-test"); // OpenAI key still present
  });

  it("defaults to api.openai.com with no gateway header when unset", async () => {
    const fetchMock = mockFetch({ data: [{ embedding: [0.1] }] });
    await embedTexts(env, ["a"]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.openai.com/v1/embeddings");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["cf-aig-authorization"]).toBeUndefined();
  });

  it("applies the gateway base to streaming chat too", async () => {
    const fetchMock = vi.fn(async (_url?: unknown, _init?: unknown) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            c.close();
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const gwEnv = { ...env, OPENAI_BASE_URL: "https://gw.example/openai" } as unknown as Env;
    for await (const _ of chatStream(gwEnv, [{ role: "user", content: "q" }])) void _;
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://gw.example/openai/chat/completions");
  });
});

describe("chatStream", () => {
  function sseResponse(lines: string[]) {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const l of lines) controller.enqueue(enc.encode(l));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  it("requests stream:true and yields delta text chunks in order", async () => {
    const fetchMock = vi.fn(async (_url?: unknown, _init?: unknown) =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const chunks: string[] = [];
    for await (const t of chatStream(env, [{ role: "user", content: "q" }])) chunks.push(t);

    expect(chunks).toEqual(["Hel", "lo"]);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.stream).toBe(true);
  });

  it("handles SSE events split across network chunks", async () => {
    const full = 'data: {"choices":[{"delta":{"content":"AB"}}]}\n\n';
    const fetchMock = vi.fn(async () => sseResponse([full.slice(0, 20), full.slice(20), "data: [DONE]\n\n"]));
    vi.stubGlobal("fetch", fetchMock);

    const chunks: string[] = [];
    for await (const t of chatStream(env, [{ role: "user", content: "q" }])) chunks.push(t);
    expect(chunks).toEqual(["AB"]);
  });

  it("throws on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const run = async () => {
      for await (const _ of chatStream(env, [{ role: "user", content: "q" }])) void _;
    };
    await expect(run()).rejects.toThrow(/500|OpenAI/);
  });
});

describe("chatStreamWithTools", () => {
  const TOOLS: ToolDefinition[] = [
    {
      type: "function",
      function: { name: "search_passages", description: "d", parameters: { type: "object" } },
    },
  ];

  function sseResponse(lines: string[]) {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const l of lines) controller.enqueue(enc.encode(l));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
    const out: StreamEvent[] = [];
    for await (const e of gen) out.push(e);
    return out;
  }

  it("sends tools (and tool_choice) in the body and yields plain content deltas", async () => {
    const fetchMock = vi.fn(async (_url?: unknown, _init?: unknown) =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const events = await collect(
      chatStreamWithTools(env, [{ role: "user", content: "q" }], TOOLS, "none"),
    );
    expect(events).toEqual([{ type: "delta", text: "你好" }]);

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.stream).toBe(true);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe("search_passages");
    expect(body.tool_choice).toBe("none");
  });

  it("accumulates fragmented tool_call arguments and yields one tool_calls event", async () => {
    const fetchMock = vi.fn(async (_url?: unknown, _init?: unknown) =>
      sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search_passages","arguments":""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"query\\":\\"face"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":" recognition\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const events = await collect(chatStreamWithTools(env, [{ role: "user", content: "q" }], TOOLS));
    expect(events).toEqual([
      {
        type: "tool_calls",
        calls: [{ id: "call_1", name: "search_passages", arguments: '{"query":"face recognition"}' }],
      },
    ]);
    // no tool_choice key when unset
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).not.toHaveProperty("tool_choice");
  });

  it("handles two parallel tool calls interleaved by index", async () => {
    const fetchMock = vi.fn(async (_url?: unknown, _init?: unknown) =>
      sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"search_passages","arguments":"{\\"q"}},{"index":1,"id":"b","function":{"name":"get_paper_card","arguments":""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"file\\":\\"x.pdf\\"}"}},{"index":0,"function":{"arguments":"uery\\":\\"a\\"}"}}]}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const events = await collect(chatStreamWithTools(env, [{ role: "user", content: "q" }], TOOLS));
    expect(events).toEqual([
      {
        type: "tool_calls",
        calls: [
          { id: "a", name: "search_passages", arguments: '{"query":"a"}' },
          { id: "b", name: "get_paper_card", arguments: '{"file":"x.pdf"}' },
        ],
      },
    ]);
  });

  it("yields content deltas before a trailing tool_calls flush and throws on non-OK", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"content":"先想想"}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"list_papers","arguments":"{}"}}]}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      ),
    );
    let events = await collect(chatStreamWithTools(env, [{ role: "user", content: "q" }], TOOLS));
    expect(events[0]).toEqual({ type: "delta", text: "先想想" });
    expect(events[1]).toEqual({
      type: "tool_calls",
      calls: [{ id: "c", name: "list_papers", arguments: "{}" }],
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const run = async () => {
      for await (const _ of chatStreamWithTools(env, [{ role: "user", content: "q" }], TOOLS)) void _;
    };
    await expect(run()).rejects.toThrow(/500|OpenAI/);
  });

  it("accepts assistant tool_calls and role:tool messages in the transcript", async () => {
    const fetchMock = vi.fn(async (_url?: unknown, _init?: unknown) => sseResponse(["data: [DONE]\n\n"]));
    vi.stubGlobal("fetch", fetchMock);
    await collect(
      chatStreamWithTools(
        env,
        [
          { role: "user", content: "q" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "a", type: "function", function: { name: "list_papers", arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: "a", content: "[]" },
        ],
        TOOLS,
      ),
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages).toHaveLength(3);
    expect(body.messages[2]).toEqual({ role: "tool", tool_call_id: "a", content: "[]" });
  });
});
