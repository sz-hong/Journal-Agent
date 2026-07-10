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

/** OpenAI fetch mock: embeddings, planner, summary, and (streaming) answers. */
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
  it("scopes vectors and the KV manifest to the session", async () => {
    installOpenAiMock({ summary: "自動摘要。" });
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

    const upserted = (env.VECTORIZE.upsert as any).mock.calls[0][0];
    expect(upserted[0].metadata.session_id).toBe(SID);

    const stored = env.KV.store.get(paperKey(SID, "newpaper.pdf"));
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored!.value).chunkIds).toHaveLength(data.added);
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

describe("POST /s/:sid/chat", () => {
  it("uses KV history, retrieves with the session filter, answers, and persists the turn with quote-bearing citations", async () => {
    const fetchMock = installOpenAiMock({ answer: "grounded answer", queries: ["q1"] });
    const kv = makeKv({
      [chatKey(SID, "chat-1")]: {
        value: JSON.stringify({
          title: "既有對話",
          createdAt: 1,
          updatedAt: 1,
          messages: [
            { role: "user", content: "earlier question" },
            { role: "assistant", content: "earlier answer", citations: [{ title: "T", page: 1 }] },
          ],
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

    const queryOpts = (env.VECTORIZE.query as any).mock.calls[0][1];
    expect(queryOpts.filter).toEqual({ session_id: SID });

    const plannerCall = fetchMock.mock.calls.find(([u, i]: any[]) => {
      if (!String(u).includes("/chat/completions")) return false;
      const b = JSON.parse(i.body);
      return (b.messages?.[0]?.content ?? "").includes("vector-search queries");
    });
    expect(JSON.stringify(JSON.parse((plannerCall![1] as any).body).messages)).toContain("earlier question");

    const rec = JSON.parse(kv.store.get(chatKey(SID, "chat-1"))!.value);
    expect(rec.messages).toHaveLength(4);
    expect(rec.messages[2]).toMatchObject({ role: "user", content: "follow-up?" });
    expect(rec.messages[3].role).toBe("assistant");
    // stored citations carry the retrieved passage for hover restore
    expect(rec.messages[3].citations[0].text).toBe("EU AI Act regulates live FRT.");
  });

  it("streams SSE by default and persists after done", async () => {
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
    expect(text.indexOf("event: meta")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("event: done")).toBeGreaterThan(text.indexOf("event: delta"));

    const rec = JSON.parse(kv.store.get(chatKey(SID, "chat-9"))!.value);
    expect(rec.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(rec.messages[1].content).toBe("Streamed!");
    expect(rec.messages[1].citations[0].text).toBeTruthy();
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
