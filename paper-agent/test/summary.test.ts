import { describe, it, expect, vi, afterEach } from "vitest";
import { summarizePaper } from "../src/summary";
import type { Env, PdfPage } from "../src/types";

const env = {
  OPENAI_API_KEY: "sk-test",
  OPENAI_CHAT_MODEL: "gpt-4o-mini",
} as unknown as Env;

const pages: PdfPage[] = [
  { page: 1, text: "Abstract: We survey face recognition. ".repeat(40) },
  { page: 2, text: "Methods include CNN and eigenfaces. ".repeat(40) },
];

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

describe("summarizePaper", () => {
  it("returns the model's summary text", async () => {
    mockChatCompletion("這篇論文回顧了人臉辨識技術。");
    expect(await summarizePaper(env, "Survey of FR", pages)).toBe("這篇論文回顧了人臉辨識技術。");
  });

  it("prompts in Traditional Chinese with the paper title and leading text, capped in length", async () => {
    const fetchMock = mockChatCompletion("摘要");
    await summarizePaper(env, "Survey of FR", pages);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const allText = JSON.stringify(body.messages);
    expect(allText).toContain("繁體中文");
    expect(allText).toContain("Survey of FR");
    expect(allText).toContain("Abstract: We survey face recognition.");
    // input excerpt is capped so huge PDFs don't blow the prompt
    const userMsg = body.messages.find((m: any) => m.role === "user").content;
    expect(userMsg.length).toBeLessThan(8000);
  });

  it("returns an empty string when the model call fails (summary is best-effort)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    expect(await summarizePaper(env, "T", pages)).toBe("");
  });
});
