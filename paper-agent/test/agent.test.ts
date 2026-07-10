import { describe, it, expect, vi, afterEach } from "vitest";
import { runAgent, MAX_ROUNDS } from "../src/agent";
import { buildAgentMessages } from "../src/prompt";
import type { AgentEvent } from "../src/agent";
import type { Env } from "../src/types";

const SID = "11111111-aaaa-bbbb-cccc-222222222222";

const MANIFESTS: Record<string, string> = {
  [`s:${SID}:paper:laws.pdf`]: JSON.stringify({
    title: "Lynch (2024)",
    summary: "監管概述。",
    chunkIds: ["a"],
    card: {
      overview: "監管概述。",
      why: "為何重要。",
      how: "個案研究。",
      what: "主要發現。",
      limitations: "限制。",
      generatedAt: 1,
    },
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

/** Build one SSE Response whose payload is a scripted list of data lines. */
function sseResponse(lines: string[]) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const l of lines) controller.enqueue(enc.encode(l));
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function contentSse(texts: string[]) {
  return sseResponse(
    texts.map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`),
  );
}

function toolCallSse(calls: Array<{ id: string; name: string; args: object }>) {
  const tool_calls = calls.map((c, index) => ({
    index,
    id: c.id,
    type: "function",
    function: { name: c.name, arguments: JSON.stringify(c.args) },
  }));
  return sseResponse([`data: ${JSON.stringify({ choices: [{ delta: { tool_calls } }] })}\n\n`]);
}

/**
 * fetch mock: embeddings answered statically; each /chat/completions call
 * consumes the next scripted SSE response. Returns the chat call bodies.
 */
function installScriptedFetch(script: Response[]) {
  const chatBodies: any[] = [];
  const fn = vi.fn(async (url?: unknown, init?: unknown) => {
    const u = String(url);
    if (u.includes("/embeddings")) {
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    chatBodies.push(JSON.parse((init as RequestInit).body as string));
    const next = script.shift();
    if (!next) throw new Error("scripted fetch exhausted");
    return next;
  });
  vi.stubGlobal("fetch", fn);
  return { fn, chatBodies };
}

async function run(env: Env, question = "問題") {
  const events: AgentEvent[] = [];
  const result = await runAgent(env, SID, buildAgentMessages(question), async (e) => {
    events.push(e);
  });
  return { events, result };
}

afterEach(() => vi.unstubAllGlobals());

describe("buildAgentMessages", () => {
  it("puts the tool-usage system prompt first, history in the middle, question last", () => {
    const msgs = buildAgentMessages("Q", [
      { role: "user", content: "prev-q" },
      { role: "assistant", content: "prev-a" },
    ]);
    expect(msgs).toHaveLength(4);
    const sys = (msgs[0] as any).content as string;
    expect((msgs[0] as any).role).toBe("system");
    expect(sys).toContain("繁體中文");
    expect(sys).toContain("(Title, p.PAGE)");
    expect(sys).toContain("English");
    expect(sys).toContain("逐維度"); // comparison guidance
    expect(sys).toContain("未涵蓋");
    expect(msgs[3]).toEqual({ role: "user", content: "Q" });
  });
});

describe("runAgent", () => {
  it("search round then answer round: emits tool → meta → deltas, collects contexts", async () => {
    const { chatBodies } = installScriptedFetch([
      toolCallSse([{ id: "c1", name: "search_passages", args: { query: "EU AI act" } }]),
      contentSse(["答案", "在此 (Lynch (2024), p.10)"]),
    ]);

    const { events, result } = await run(makeEnv());

    expect(events.map((e) => e.type)).toEqual(["tool", "meta", "delta", "delta"]);
    expect(events[0]).toMatchObject({ type: "tool", name: "search_passages", args: { query: "EU AI act" } });
    const meta = events[1] as any;
    expect(meta.contexts).toHaveLength(1);
    expect(meta.citations).toEqual([{ title: "Lynch (2024)", page: 10 }]);

    expect(result.answer).toBe("答案在此 (Lynch (2024), p.10)");
    expect(result.contexts).toHaveLength(1);
    expect(result.citations).toEqual([{ title: "Lynch (2024)", page: 10 }]);

    // second round's transcript carries the assistant tool_calls + tool result
    const second = chatBodies[1].messages;
    const assistantTurn = second.find((m: any) => m.role === "assistant" && m.tool_calls);
    expect(assistantTurn.tool_calls[0].function.name).toBe("search_passages");
    const toolTurn = second.find((m: any) => m.role === "tool");
    expect(toolTurn.tool_call_id).toBe("c1");
    expect(toolTurn.content).toContain("EU AI Act regulates live FRT.");
    // every round sends the tool definitions
    expect(chatBodies[0].tools.map((t: any) => t.function.name)).toContain("search_passages");
  });

  it("answers directly with no tool round", async () => {
    installScriptedFetch([contentSse(["直接回答"])]);
    const { events, result } = await run(makeEnv());
    expect(result.answer).toBe("直接回答");
    expect(result.contexts).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(["delta"]);
  });

  it("executes parallel tool calls in one round and appends one tool message each", async () => {
    const { chatBodies } = installScriptedFetch([
      toolCallSse([
        { id: "a", name: "list_papers", args: {} },
        { id: "b", name: "get_paper_card", args: { file: "laws.pdf" } },
      ]),
      contentSse(["綜合回答"]),
    ]);
    const { events, result } = await run(makeEnv());
    expect(result.answer).toBe("綜合回答");
    // two tool events, no meta (neither tool returns contexts)
    expect(events.filter((e) => e.type === "tool")).toHaveLength(2);
    expect(events.filter((e) => e.type === "meta")).toHaveLength(0);
    const toolMsgs = chatBodies[1].messages.filter((m: any) => m.role === "tool");
    expect(toolMsgs.map((m: any) => m.tool_call_id)).toEqual(["a", "b"]);
    expect(toolMsgs[1].content).toContain("為何重要。");
  });

  it("forces a final answer with tool_choice:none when rounds run out", async () => {
    const toolRound = () =>
      toolCallSse([{ id: "x", name: "search_passages", args: { query: "same thing" } }]);
    installScriptedFetch([
      ...Array.from({ length: MAX_ROUNDS - 1 }, () => toolRound()),
      contentSse(["最終回答"]),
    ]);
    const { chatBodies } = { chatBodies: [] as any[] };
    void chatBodies;
    const { result } = await run(makeEnv());
    expect(result.answer).toBe("最終回答");
  });

  it("sends tool_choice:none on the last round", async () => {
    const toolRound = () =>
      toolCallSse([{ id: "x", name: "search_passages", args: { query: "same thing" } }]);
    const { chatBodies } = installScriptedFetch([
      ...Array.from({ length: MAX_ROUNDS - 1 }, () => toolRound()),
      contentSse(["最終回答"]),
    ]);
    await run(makeEnv());
    expect(chatBodies).toHaveLength(MAX_ROUNDS);
    expect(chatBodies[MAX_ROUNDS - 1].tool_choice).toBe("none");
    for (const body of chatBodies.slice(0, MAX_ROUNDS - 1)) {
      expect(body).not.toHaveProperty("tool_choice");
    }
  });

  it("feeds tool errors back to the model and continues (bad query self-corrects)", async () => {
    const { chatBodies } = installScriptedFetch([
      toolCallSse([{ id: "bad", name: "search_passages", args: { query: "人臉辨識法規" } }]),
      toolCallSse([{ id: "ok", name: "search_passages", args: { query: "face recognition law" } }]),
      contentSse(["修正後回答"]),
    ]);
    const { events, result } = await run(makeEnv());
    expect(result.answer).toBe("修正後回答");
    const errTurn = chatBodies[1].messages.find((m: any) => m.role === "tool");
    expect(errTurn.content).toMatch(/English keywords/);
    // only the successful search contributes contexts/meta
    expect(events.filter((e) => e.type === "meta")).toHaveLength(1);
    expect(result.contexts).toHaveLength(1);
  });
});
