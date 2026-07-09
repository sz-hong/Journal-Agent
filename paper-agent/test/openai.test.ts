import { describe, it, expect, vi, afterEach } from "vitest";
import { embedTexts, embedQuery, chat } from "../src/openai";
import type { Env } from "../src/types";

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
});
