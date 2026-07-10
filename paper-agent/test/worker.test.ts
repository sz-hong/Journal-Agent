import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../src/types";

// Mock the PDF parser so /ingest tests don't need a real PDF / pdfjs.
vi.mock("../src/pdf", () => ({ extractPdfPages: vi.fn() }));
import { extractPdfPages } from "../src/pdf";
import app from "../src/index";

const SID = "11111111-aaaa-bbbb-cccc-222222222222";
const OTHER_SID = "99999999-dddd-eeee-ffff-000000000000";
const TEST_EMAIL = "u@test.tw";
const TEST_TOKEN = "test-token-abcdefghijklmnopqrstuvwxyz";
const AUTH = { Authorization: `Bearer ${TEST_TOKEN}` };

const matches = [
  {
    id: "h::p10::c0",
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
    id: "h::p5::c2",
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

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function jsonResponse(o: unknown) {
  return new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
}

const CARD_FIXTURE = {
  overview: "本文提出人臉辨識新法。",
  why: "遮擋問題重要。",
  how: "CNN + LFW。",
  what: "準確率 99.2%。",
  limitations: "未測跨種族偏差。",
};

/** Build one SSE response from scripted data lines (auto-terminated). */
function sseFrom(lines: string[]) {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const l of lines) c.enqueue(enc.encode(l));
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** One agent round that streams plain answer text. */
function agentAnswer(texts: string[]) {
  return sseFrom(texts.map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`));
}

/** One agent round that requests tool calls. */
function agentToolCalls(calls: Array<{ id: string; name: string; args: object }>) {
  const tool_calls = calls.map((c, index) => ({
    index,
    id: c.id,
    type: "function",
    function: { name: c.name, arguments: JSON.stringify(c.args) },
  }));
  return sseFrom([`data: ${JSON.stringify({ choices: [{ delta: { tool_calls } }] })}\n\n`]);
}

/**
 * OpenAI fetch mock: embeddings, summary, paper card, and the agent loop's
 * tool-calling chat requests (identified by `tools` in the body), which
 * consume the scripted `agent` responses in order.
 */
function installOpenAiMock(
  opts: { answer?: string; summary?: string; card?: object | string; agent?: Response[] } = {},
) {
  const { answer = "mocked answer", summary = "模擬摘要", card = CARD_FIXTURE } = opts;
  const agentScript = opts.agent ?? [
    agentToolCalls([{ id: "t1", name: "search_passages", args: { query: "standalone query" } }]),
    agentAnswer([answer.slice(0, 3), answer.slice(3)]),
  ];
  const fn = vi.fn(async (url: any, init: any) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : {};
    if (u.includes("/embeddings")) {
      const inputs: string[] = body.input;
      return jsonResponse({ data: inputs.map(() => ({ embedding: [0.1, 0.2, 0.3] })) });
    }
    if (u.includes("/chat/completions")) {
      // Agent-loop requests carry tool definitions; check before the
      // system-prompt markers (the agent prompt mentions 結構化卡片 too).
      if (Array.isArray(body.tools)) {
        const next = agentScript.shift();
        return next ?? new Response("agent script exhausted", { status: 500 });
      }
      const sys: string = body.messages?.[0]?.content ?? "";
      if (sys.includes("逐段筆記")) {
        return jsonResponse({ choices: [{ message: { role: "assistant", content: "分批筆記" } }] });
      }
      if (sys.includes("結構化卡片")) {
        const content = typeof card === "string" ? card : JSON.stringify(card);
        return jsonResponse({ choices: [{ message: { role: "assistant", content } }] });
      }
      if (sys.includes("摘要")) {
        return jsonResponse({ choices: [{ message: { role: "assistant", content: summary } }] });
      }
      return jsonResponse({ choices: [{ message: { role: "assistant", content: answer } }] });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Bodies of the agent-loop chat requests (those carrying `tools`). */
function agentBodies(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .filter(([u, i]: any[]) => String(u).includes("/chat/completions") && i?.body)
    .map(([, i]: any[]) => JSON.parse(i.body))
    .filter((b: any) => Array.isArray(b.tools));
}

/** Prefix-aware in-memory KV mock. */
function makeKv(seed: Record<string, { value: string; metadata?: unknown }> = {}) {
  const store = new Map<string, { value: string; metadata?: unknown }>(Object.entries(seed));
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key)?.value ?? null),
    put: vi.fn(async (key: string, value: string, opts?: { metadata?: unknown }) => {
      store.set(key, { value, metadata: opts?.metadata });
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async ({ prefix = "" }: { prefix?: string } = {}) => ({
      keys: [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([name, v]) => ({ name, metadata: v.metadata })),
      list_complete: true,
    })),
  };
}

const paperKey = (sid: string, file: string) => `s:${sid}:paper:${file}`;
const chatKey = (sid: string, id: string) => `s:${sid}:chat:${id}`;

const LAWS_MANIFEST = JSON.stringify({
  title: "Lynch (2024)",
  summary: "本文探討人臉辨識監管。",
  chunkIds: ["h1::p1::c0", "h1::p2::c0"],
});

const TEST_USER = JSON.stringify({
  pwHash: "unused",
  salt: "unused",
  iterations: 1,
  profile: { name: "測試", school: "台大", dept: "資工", role: "研究生" },
  sessions: [],
  createdAt: 1,
});

function makeEnv(kv = makeKv()): Env & { KV: ReturnType<typeof makeKv> } {
  // seed the authenticated test user + its bearer token
  kv.store.set(`tok:${TEST_TOKEN}`, { value: TEST_EMAIL });
  if (!kv.store.has(`user:${TEST_EMAIL}`)) kv.store.set(`user:${TEST_EMAIL}`, { value: TEST_USER });
  return {
    KV: kv,
    OPENAI_API_KEY: "sk-test",
    OPENAI_EMBED_MODEL: "text-embedding-3-small",
    OPENAI_CHAT_MODEL: "gpt-4o-mini",
    VECTORIZE: {
      query: vi.fn(async () => ({ count: matches.length, matches })),
      upsert: vi.fn(async () => ({ mutationId: "m1" })),
      deleteByIds: vi.fn(async () => ({ mutationId: "m2" })),
      getByIds: vi.fn(async () => []),
    },
    PAPERS_KV: kv,
    ASSETS: { fetch: vi.fn(async () => new Response("<html>ui</html>", { headers: { "content-type": "text/html" } })) },
  } as unknown as Env & { KV: ReturnType<typeof makeKv> };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

// ---------- 帳號 ----------

describe("auth: register / login / me / profile / logout", () => {
  it("registers, then logs in with the same password", async () => {
    const env = makeEnv();
    let res = await app.fetch(
      new Request("http://x/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "New@Example.com",
          password: "hunter22222",
          profile: { name: "小明", school: "台大", dept: "資工", role: "研究生" },
        }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const reg = (await res.json()) as any;
    expect(reg.token).toBeTruthy();
    expect(reg.email).toBe("new@example.com"); // normalized
    expect(reg.profile.name).toBe("小明");

    res = await app.fetch(
      new Request("http://x/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "new@example.com", password: "hunter22222" }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).token).toBeTruthy();
  });

  it("409s on duplicate registration and 400s on short passwords / bad email", async () => {
    const env = makeEnv();
    const reg = (body: object) =>
      app.fetch(
        new Request("http://x/auth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        env,
        ctx,
      );
    expect((await reg({ email: TEST_EMAIL, password: "longenough1" })).status).toBe(409);
    expect((await reg({ email: "a@b.c", password: "short" })).status).toBe(400);
    expect((await reg({ email: "not-an-email", password: "longenough1" })).status).toBe(400);
  });

  it("401s a wrong password with the same message as an unknown account", async () => {
    const env = makeEnv();
    await app.fetch(
      new Request("http://x/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "a@b.c", password: "correct-pw-1" }),
      }),
      env,
      ctx,
    );
    const login = (body: object) =>
      app.fetch(
        new Request("http://x/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        env,
        ctx,
      );
    const wrong = await login({ email: "a@b.c", password: "wrong-pw-11" });
    const unknown = await login({ email: "no@one.tw", password: "whatever-11" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(((await wrong.json()) as any).error).toBe(((await unknown.json()) as any).error);
  });

  it("GET /auth/me returns profile + sessions with a valid token; 401 without", async () => {
    const env = makeEnv();
    let res = await app.fetch(new Request("http://x/auth/me", { headers: AUTH }), env, ctx);
    expect(res.status).toBe(200);
    const me = (await res.json()) as any;
    expect(me.email).toBe(TEST_EMAIL);
    expect(me.profile.name).toBe("測試");

    res = await app.fetch(new Request("http://x/auth/me"), env, ctx);
    expect(res.status).toBe(401);
  });

  it("PUT /auth/profile merges fields", async () => {
    const env = makeEnv();
    const res = await app.fetch(
      new Request("http://x/auth/profile", {
        method: "PUT",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ profile: { dept: "電機" } }),
      }),
      env,
      ctx,
    );
    const data = (await res.json()) as any;
    expect(data.profile.dept).toBe("電機");
    expect(data.profile.name).toBe("測試"); // untouched fields preserved
  });

  it("logout revokes the token", async () => {
    const env = makeEnv();
    let res = await app.fetch(new Request("http://x/auth/logout", { method: "POST", headers: AUTH }), env, ctx);
    expect(res.status).toBe(200);
    res = await app.fetch(new Request("http://x/auth/me", { headers: AUTH }), env, ctx);
    expect(res.status).toBe(401);
  });
});

describe("auth: /me/sessions list sync", () => {
  it("upserts (create/rename/revisit) and removes sessions", async () => {
    const env = makeEnv();
    const post = (body: object) =>
      app.fetch(
        new Request("http://x/me/sessions", {
          method: "POST",
          headers: { ...AUTH, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        env,
        ctx,
      );

    await post({ id: SID, name: "我的研讀", role: "擁有者" });
    await post({ id: OTHER_SID, name: "協作", role: "成員" });
    let data = (await (await post({ id: SID })).json()) as any; // revisit: moves to front, keeps name
    expect(data.sessions.map((s: any) => s.id)).toEqual([SID, OTHER_SID]);
    expect(data.sessions[0].name).toBe("我的研讀");

    const res = await app.fetch(
      new Request(`http://x/me/sessions/${OTHER_SID}`, { method: "DELETE", headers: AUTH }),
      env,
      ctx,
    );
    data = (await res.json()) as any;
    expect(data.sessions.map((s: any) => s.id)).toEqual([SID]);
  });

  it("401s without a token", async () => {
    const res = await app.fetch(
      new Request("http://x/me/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: SID }),
      }),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(401);
  });
});

// ---------- 守門 ----------

describe("session route guard", () => {
  it("401s /s/* without a token (papers, chat, ingest, delete)", async () => {
    const env = makeEnv();
    for (const req of [
      new Request(`http://x/s/${SID}/papers`),
      new Request(`http://x/s/${SID}/chat`, { method: "POST", body: "{}" }),
      new Request(`http://x/s/${SID}/ingest`, { method: "POST" }),
      new Request(`http://x/s/${SID}`, { method: "DELETE" }),
    ]) {
      const res = await app.fetch(req, env, ctx);
      expect(res.status).toBe(401);
    }
  });

  it("400s on a malformed session id (before auth)", async () => {
    const res = await app.fetch(new Request("http://x/s/ab/papers", { headers: AUTH }), makeEnv(), ctx);
    expect(res.status).toBe(400);
  });

  it("serves the static UI without auth", async () => {
    const res = await app.fetch(new Request("http://x/"), makeEnv(), ctx);
    expect(res.status).toBe(200);
  });
});

// ---------- 資料路由（帶 token） ----------

describe("error surfacing", () => {
  it("returns the underlying error message as JSON on unhandled failures", async () => {
    installOpenAiMock();
    const env = makeEnv();
    (env.VECTORIZE.query as any).mockRejectedValue(new Error("vector index exploded"));
    const res = await app.fetch(
      new Request(`http://x/s/${SID}/chat`, {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ chatId: "c1", message: "q", stream: false }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(500);
    expect(((await res.json()) as any).error).toContain("vector index exploded");
  });
});

describe("GET /s/:sid/papers", () => {
  it("lists only this session's papers, with summaries", async () => {
    const kv = makeKv({
      [paperKey(SID, "laws.pdf")]: { value: LAWS_MANIFEST, metadata: { title: "Lynch (2024)" } },
      [paperKey(OTHER_SID, "other.pdf")]: { value: JSON.stringify({ title: "X", summary: "", chunkIds: [] }) },
      [chatKey(SID, "c1")]: { value: JSON.stringify({ title: "t", createdAt: 1, updatedAt: 1, messages: [] }) },
    });
    const res = await app.fetch(new Request(`http://x/s/${SID}/papers`, { headers: AUTH }), makeEnv(kv), ctx);
    const data = (await res.json()) as any;
    expect(data.papers).toEqual([
      { file: "laws.pdf", title: "Lynch (2024)", summary: "本文探討人臉辨識監管。" },
    ]);
  });

  it("returns an empty list for a brand-new session", async () => {
    const res = await app.fetch(new Request(`http://x/s/${SID}/papers`, { headers: AUTH }), makeEnv(), ctx);
    expect(((await res.json()) as any).papers).toEqual([]);
  });
});

describe("POST /s/:sid/ingest", () => {
  it("scopes vectors and the KV manifest to the session, storing the paper card", async () => {
    installOpenAiMock();
    (extractPdfPages as any).mockResolvedValue([{ page: 1, text: "x".repeat(300) }]);
    const env = makeEnv();

    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3])], "newpaper.pdf", { type: "application/pdf" }));
    const res = await app.fetch(
      new Request(`http://x/s/${SID}/ingest`, { method: "POST", headers: AUTH, body: form }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    // the summary blurb comes from the structured card's overview
    expect(data.summary).toBe(CARD_FIXTURE.overview);
    expect(data.card.what).toBe(CARD_FIXTURE.what);

    const upserted = (env.VECTORIZE.upsert as any).mock.calls[0][0];
    expect(upserted[0].metadata.session_id).toBe(SID);

    const stored = env.KV.store.get(paperKey(SID, "newpaper.pdf"));
    expect(stored).toBeTruthy();
    const manifest = JSON.parse(stored!.value);
    expect(manifest.chunkIds).toHaveLength(data.added);
    expect(manifest.card.why).toBe(CARD_FIXTURE.why);
  });

  it("falls back to the plain summary when card generation fails (ingest never breaks)", async () => {
    installOpenAiMock({ card: "這不是 JSON", summary: "自動摘要。" });
    (extractPdfPages as any).mockResolvedValue([{ page: 1, text: "x".repeat(300) }]);
    const env = makeEnv();

    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3])], "newpaper.pdf", { type: "application/pdf" }));
    const res = await app.fetch(
      new Request(`http://x/s/${SID}/ingest`, { method: "POST", headers: AUTH, body: form }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.summary).toBe("自動摘要。");
    expect(data.card).toBeUndefined();
    const manifest = JSON.parse(env.KV.store.get(paperKey(SID, "newpaper.pdf"))!.value);
    expect(manifest.card).toBeUndefined();
  });
});

describe("POST /s/:sid/papers/:file/card (regenerate from stored chunks)", () => {
  /** getByIds mock: derive text/page from the chunk id (…::pN::cM). */
  const getByIdsFromIds = vi.fn(async (ids: string[]) =>
    ids.map((id) => {
      const m = id.match(/::p(\d+)::c(\d+)$/)!;
      return {
        id,
        values: [],
        metadata: {
          text: `chunk p${m[1]} c${m[2]}.`,
          title: "Lynch (2024)",
          page: Number(m[1]),
          source_file: "laws.pdf",
          session_id: SID,
        },
      };
    }),
  );

  it("rebuilds pages from chunks (batched ≤20, page-sorted), saves and returns the card", async () => {
    const fetchMock = installOpenAiMock();
    // 22 chunk ids, listed out of page order, to exercise batching + sorting
    const chunkIds = [
      "h1::p2::c0",
      "h1::p1::c1",
      "h1::p1::c0",
      ...Array.from({ length: 19 }, (_, i) => `h1::p3::c${i}`),
    ];
    const kv = makeKv({
      [paperKey(SID, "laws.pdf")]: {
        value: JSON.stringify({ title: "Lynch (2024)", summary: "舊摘要", chunkIds }),
        metadata: { title: "Lynch (2024)" },
      },
    });
    const env = makeEnv(kv);
    (env.VECTORIZE as any).getByIds = getByIdsFromIds;

    const res = await app.fetch(
      new Request(`http://x/s/${SID}/papers/laws.pdf/card`, { method: "POST", headers: AUTH }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.card.overview).toBe(CARD_FIXTURE.overview);
    expect(data.summary).toBe(CARD_FIXTURE.overview);

    // batched at 20 ids per getByIds call
    expect(getByIdsFromIds).toHaveBeenCalledTimes(2);
    expect(getByIdsFromIds.mock.calls[0][0]).toHaveLength(20);
    expect(getByIdsFromIds.mock.calls[1][0]).toHaveLength(2);

    // the reduce prompt sees pages in order with chunks stitched by index
    const cardCall = fetchMock.mock.calls.find(([, init]: any) =>
      String(JSON.parse(init.body).messages?.[0]?.content ?? "").includes("結構化卡片"),
    )!;
    const user = JSON.parse((cardCall[1] as any).body).messages.find((m: any) => m.role === "user")
      .content as string;
    expect(user.indexOf("chunk p1 c0.")).toBeGreaterThan(-1);
    expect(user.indexOf("chunk p1 c0.")).toBeLessThan(user.indexOf("chunk p1 c1."));
    expect(user.indexOf("chunk p1 c1.")).toBeLessThan(user.indexOf("chunk p2 c0."));

    // manifest updated in KV with the card and new summary
    const stored = JSON.parse(env.KV.store.get(paperKey(SID, "laws.pdf"))!.value);
    expect(stored.card.why).toBe(CARD_FIXTURE.why);
    expect(stored.summary).toBe(CARD_FIXTURE.overview);
    expect(stored.chunkIds).toEqual(chunkIds);
  });

  it("404s an unknown paper and 422s when no chunk text is stored", async () => {
    installOpenAiMock();
    let res = await app.fetch(
      new Request(`http://x/s/${SID}/papers/nope.pdf/card`, { method: "POST", headers: AUTH }),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(404);

    const kv = makeKv({
      [paperKey(SID, "laws.pdf")]: { value: LAWS_MANIFEST, metadata: { title: "Lynch (2024)" } },
    });
    const env = makeEnv(kv); // default getByIds returns []
    res = await app.fetch(
      new Request(`http://x/s/${SID}/papers/laws.pdf/card`, { method: "POST", headers: AUTH }),
      env,
      ctx,
    );
    expect(res.status).toBe(422);
  });

  it("502s (without overwriting the manifest) when card generation fails", async () => {
    installOpenAiMock({ card: "not json" });
    const kv = makeKv({
      [paperKey(SID, "laws.pdf")]: { value: LAWS_MANIFEST, metadata: { title: "Lynch (2024)" } },
    });
    const env = makeEnv(kv);
    (env.VECTORIZE as any).getByIds = getByIdsFromIds;
    const res = await app.fetch(
      new Request(`http://x/s/${SID}/papers/laws.pdf/card`, { method: "POST", headers: AUTH }),
      env,
      ctx,
    );
    expect(res.status).toBe(502);
    expect(env.KV.store.get(paperKey(SID, "laws.pdf"))!.value).toBe(LAWS_MANIFEST);
  });
});

describe("chat rooms CRUD", () => {
  it("creates, lists (session-scoped), reads, and deletes chats", async () => {
    const env = makeEnv();

    let res = await app.fetch(
      new Request(`http://x/s/${SID}/chats`, {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ id: "chat-1" }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).title).toBe("新對話");

    env.KV.store.set(chatKey(OTHER_SID, "foreign"), {
      value: JSON.stringify({ title: "x", createdAt: 1, updatedAt: 1, messages: [] }),
      metadata: { title: "x", updatedAt: 1 },
    });

    res = await app.fetch(new Request(`http://x/s/${SID}/chats`, { headers: AUTH }), env, ctx);
    const list = (await res.json()) as any;
    expect(list.chats).toHaveLength(1);
    expect(list.chats[0].id).toBe("chat-1");

    res = await app.fetch(new Request(`http://x/s/${SID}/chats/chat-1`, { headers: AUTH }), env, ctx);
    expect(((await res.json()) as any).messages).toEqual([]);

    res = await app.fetch(new Request(`http://x/s/${SID}/chats/chat-1`, { method: "DELETE", headers: AUTH }), env, ctx);
    expect(res.status).toBe(200);
    expect(env.KV.store.has(chatKey(SID, "chat-1"))).toBe(false);
  });

  it("404s reading a missing chat", async () => {
    const res = await app.fetch(new Request(`http://x/s/${SID}/chats/nope`, { headers: AUTH }), makeEnv(), ctx);
    expect(res.status).toBe(404);
  });
});

describe("POST /s/:sid/chat (agent loop)", () => {
  it("uses windowed KV history, searches with the session filter, answers, and persists quote-bearing citations", async () => {
    const fetchMock = installOpenAiMock({ answer: "grounded answer" });
    // 10 stored messages: the first two fall outside HISTORY_WINDOW (8)
    const oldMessages = [
      { role: "user", content: "dropped question" },
      { role: "assistant", content: "dropped answer" },
      ...Array.from({ length: 7 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `filler ${i}`,
      })),
      { role: "user", content: "earlier question" },
    ];
    const kv = makeKv({
      [chatKey(SID, "chat-1")]: {
        value: JSON.stringify({
          title: "既有對話",
          createdAt: 1,
          updatedAt: 1,
          messages: oldMessages,
        }),
        metadata: { title: "既有對話", updatedAt: 1 },
      },
    });
    const env = makeEnv(kv);

    const res = await app.fetch(
      new Request(`http://x/s/${SID}/chat`, {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ chatId: "chat-1", message: "follow-up?", stream: false }),
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.answer).toBe("grounded answer");
    expect(data.citations[0]).toMatchObject({ title: "Lynch (2024)", page: 10 });

    const queryOpts = (env.VECTORIZE.query as any).mock.calls[0][1];
    expect(queryOpts.filter).toEqual({ session_id: SID });

    // the agent request carries the recent history but not what fell out of the window
    const firstAgentBody = agentBodies(fetchMock)[0];
    const serialized = JSON.stringify(firstAgentBody.messages);
    expect(serialized).toContain("earlier question");
    expect(serialized).not.toContain("dropped question");

    const rec = JSON.parse(kv.store.get(chatKey(SID, "chat-1"))!.value);
    expect(rec.messages).toHaveLength(oldMessages.length + 2);
    expect(rec.messages.at(-2)).toMatchObject({ role: "user", content: "follow-up?" });
    expect(rec.messages.at(-1).role).toBe("assistant");
    // stored citations carry the retrieved passage for hover restore
    expect(rec.messages.at(-1).citations[0].text).toBe("EU AI Act regulates live FRT.");
  });

  it("streams tool → meta → delta → done over SSE and persists after done", async () => {
    installOpenAiMock({ answer: "Streamed!" });
    const kv = makeKv();
    const env = makeEnv(kv);
    const res = await app.fetch(
      new Request(`http://x/s/${SID}/chat`, {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ chatId: "chat-9", message: "q" }),
      }),
      env,
      ctx,
    );
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const iTool = text.indexOf("event: tool");
    const iMeta = text.indexOf("event: meta");
    const iDelta = text.indexOf("event: delta");
    const iDone = text.indexOf("event: done");
    expect(iTool).toBeGreaterThanOrEqual(0);
    expect(iMeta).toBeGreaterThan(iTool);
    expect(iDelta).toBeGreaterThan(iMeta);
    expect(iDone).toBeGreaterThan(iDelta);
    expect(text).toContain('"name":"search_passages"');

    const rec = JSON.parse(kv.store.get(chatKey(SID, "chat-9"))!.value);
    expect(rec.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(rec.messages[1].content).toBe("Streamed!");
    expect(rec.messages[1].citations[0].text).toBeTruthy();
  });

  it("deep-read flow: card then paper-scoped search; contexts stay within the paper", async () => {
    const fetchMock = installOpenAiMock({
      agent: [
        agentToolCalls([{ id: "a", name: "get_paper_card", args: { file: "laws.pdf" } }]),
        agentToolCalls([
          { id: "b", name: "search_passages", args: { query: "FRT regulation", file: "laws.pdf" } },
        ]),
        agentAnswer(["深度解讀回答"]),
      ],
    });
    const kv = makeKv({
      [paperKey(SID, "laws.pdf")]: {
        value: JSON.stringify({
          title: "Lynch (2024)",
          summary: "監管概述。",
          chunkIds: ["h1::p1::c0"],
          card: CARD_FIXTURE,
        }),
        metadata: { title: "Lynch (2024)" },
      },
    });
    const env = makeEnv(kv);
    const res = await app.fetch(
      new Request(`http://x/s/${SID}/chat`, {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ chatId: "c", message: "請深度解讀 laws.pdf", stream: false }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.answer).toBe("深度解讀回答");
    // the paper-scoped search dropped the bio.pdf match
    expect(data.contexts).toHaveLength(1);
    expect(data.contexts[0].sourceFile).toBe("laws.pdf");
    // the card content reached the model as a tool result
    const bodies = agentBodies(fetchMock);
    const toolMsgs = bodies[2].messages.filter((m: any) => m.role === "tool");
    expect(JSON.stringify(toolMsgs)).toContain(CARD_FIXTURE.why);
    // scoped search used the larger topK
    expect((env.VECTORIZE.query as any).mock.calls[0][1].topK).toBe(12);
  });

  it("compare flow: list_papers then per-paper cards, all reaching the model", async () => {
    const fetchMock = installOpenAiMock({
      agent: [
        agentToolCalls([{ id: "a", name: "list_papers", args: {} }]),
        agentToolCalls([
          { id: "b", name: "get_paper_card", args: { file: "laws.pdf" } },
          { id: "c", name: "get_paper_card", args: { file: "bio.pdf" } },
        ]),
        agentAnswer(["逐維度比較回答"]),
      ],
    });
    const bioCard = { ...CARD_FIXTURE, why: "疾病診斷的臨床需求。" };
    const kv = makeKv({
      [paperKey(SID, "laws.pdf")]: {
        value: JSON.stringify({
          title: "Lynch (2024)",
          summary: "s1",
          chunkIds: [],
          card: CARD_FIXTURE,
        }),
        metadata: { title: "Lynch (2024)" },
      },
      [paperKey(SID, "bio.pdf")]: {
        value: JSON.stringify({
          title: "Qiang et al. (2022)",
          summary: "s2",
          chunkIds: [],
          card: bioCard,
        }),
        metadata: { title: "Qiang et al. (2022)" },
      },
    });
    const res = await app.fetch(
      new Request(`http://x/s/${SID}/chat`, {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ chatId: "c", message: "比較這兩篇", stream: false }),
      }),
      makeEnv(kv),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).answer).toBe("逐維度比較回答");

    const bodies = agentBodies(fetchMock);
    const listResult = JSON.stringify(bodies[1].messages.filter((m: any) => m.role === "tool"));
    expect(listResult).toContain("laws.pdf");
    expect(listResult).toContain("bio.pdf");
    const cardResults = JSON.stringify(bodies[2].messages.filter((m: any) => m.role === "tool"));
    expect(cardResults).toContain(CARD_FIXTURE.why);
    expect(cardResults).toContain("疾病診斷的臨床需求。");
  });

  it("feeds a tool error back to the model and still completes the answer", async () => {
    const fetchMock = installOpenAiMock({
      agent: [
        agentToolCalls([{ id: "bad", name: "search_passages", args: { query: "人臉辨識的法規" } }]),
        agentAnswer(["仍能回答"]),
      ],
    });
    const res = await app.fetch(
      new Request(`http://x/s/${SID}/chat`, {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ chatId: "c", message: "q", stream: false }),
      }),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.answer).toBe("仍能回答");
    expect(data.contexts).toEqual([]);
    const errTool = agentBodies(fetchMock)[1].messages.find((m: any) => m.role === "tool");
    expect(errTool.content).toMatch(/English keywords/);
  });

  it("400s without chatId or message", async () => {
    installOpenAiMock();
    const res = await app.fetch(
      new Request(`http://x/s/${SID}/chat`, {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ message: "q", stream: false }),
      }),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(400);
  });
});

describe("DELETE /s/:sid/papers/:file", () => {
  it("deletes vectors by chunk ids and removes the manifest", async () => {
    const kv = makeKv({
      [paperKey(SID, "laws.pdf")]: { value: LAWS_MANIFEST },
    });
    const env = makeEnv(kv);
    const res = await app.fetch(
      new Request(`http://x/s/${SID}/papers/laws.pdf`, { method: "DELETE", headers: AUTH }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect((env.VECTORIZE as any).deleteByIds).toHaveBeenCalledWith(["h1::p1::c0", "h1::p2::c0"]);
    expect(kv.store.has(paperKey(SID, "laws.pdf"))).toBe(false);
  });

  it("404s for a missing paper", async () => {
    const res = await app.fetch(
      new Request(`http://x/s/${SID}/papers/nope.pdf`, { method: "DELETE", headers: AUTH }),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /s/:sid (whole session)", () => {
  it("removes every vector and KV key of the session, leaving other sessions and users intact", async () => {
    const kv = makeKv({
      [paperKey(SID, "a.pdf")]: { value: JSON.stringify({ title: "A", summary: "", chunkIds: ["x1", "x2"] }) },
      [paperKey(SID, "b.pdf")]: { value: JSON.stringify({ title: "B", summary: "", chunkIds: ["y1"] }) },
      [chatKey(SID, "c1")]: { value: JSON.stringify({ title: "t", createdAt: 1, updatedAt: 1, messages: [] }) },
      [paperKey(OTHER_SID, "keep.pdf")]: { value: JSON.stringify({ title: "K", summary: "", chunkIds: ["z"] }) },
    });
    const env = makeEnv(kv);

    const res = await app.fetch(new Request(`http://x/s/${SID}`, { method: "DELETE", headers: AUTH }), env, ctx);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.removedChunks).toBe(3);
    expect(data.removedKeys).toBe(3);

    const deletedIds = (env.VECTORIZE as any).deleteByIds.mock.calls.flatMap((c: any[]) => c[0]);
    expect(deletedIds.sort()).toEqual(["x1", "x2", "y1"]);

    // other session's paper + the auth records survive
    expect(kv.store.has(paperKey(OTHER_SID, "keep.pdf"))).toBe(true);
    expect(kv.store.has(`user:${TEST_EMAIL}`)).toBe(true);
  });
});
