import { describe, it, expect, vi, afterEach } from "vitest";
import { planQueries } from "../src/plan";
import type { Env } from "../src/types";

const env = {
  OPENAI_API_KEY: "sk-test",
  OPENAI_CHAT_MODEL: "gpt-4o-mini",
} as unknown as Env;

function mockChatCompletion(content: string) {
  const fn = vi.fn(async (_url?: unknown, _init?: unknown) =>
    new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("planQueries", () => {
  it("parses a JSON array of standalone queries from the model", async () => {
    mockChatCompletion('["EU AI Act live facial recognition", "Cushing syndrome accuracy"]');
    const queries = await planQueries(env, "compare regulation and diagnosis", []);
    expect(queries).toEqual(["EU AI Act live facial recognition", "Cushing syndrome accuracy"]);
  });

  it("accepts a fenced JSON array", async () => {
    mockChatCompletion('```json\n["face recognition datasets"]\n```');
    expect(await planQueries(env, "what datasets exist?", [])).toEqual(["face recognition datasets"]);
  });

  it("falls back to the raw message when the model output is not JSON", async () => {
    mockChatCompletion("sorry, no JSON here");
    expect(await planQueries(env, "my question", [])).toEqual(["my question"]);
  });

  it("falls back to the raw message when the chat call throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    expect(await planQueries(env, "my question", [])).toEqual(["my question"]);
  });

  it("caps the number of queries at 3", async () => {
    mockChatCompletion('["a","b","c","d","e"]');
    expect(await planQueries(env, "q", [])).toHaveLength(3);
  });

  it("includes conversation history in the planning prompt", async () => {
    const fetchMock = mockChatCompletion('["FaceNet LFW accuracy"]');
    await planQueries(env, "那它的準確率呢?", [
      { role: "user", content: "tell me about FaceNet" },
      { role: "assistant", content: "FaceNet is a face recognition model." },
    ]);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const allText = JSON.stringify(body.messages);
    expect(allText).toContain("tell me about FaceNet");
    expect(allText).toContain("那它的準確率呢?");
  });
});
