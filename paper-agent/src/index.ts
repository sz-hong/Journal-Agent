import { Hono } from "hono";
import type { Env, ChatMessage, ChunkMetadata, PdfPage, UserProfile } from "./types";
import { embedTexts } from "./openai";
import { buildAgentMessages } from "./prompt";
import { attachQuotes } from "./citations";
import { extractPdfPages } from "./pdf";
import { buildVectorRecords } from "./ingest-core";
import { runAgent } from "./agent";
import type { AgentResult } from "./agent";
import { summarizePaper } from "./summary";
import { generatePaperCard } from "./card";
import { parseManifest } from "./manifest";
import { chatKey, chatPrefix, newChat, loadChat, appendMessages, listChats } from "./chats";
import {
  hashPassword,
  verifyPassword,
  issueToken,
  resolveToken,
  revokeToken,
  getUser,
  putUser,
  upsertUserSession,
  removeUserSession,
} from "./auth";

const DELETE_BATCH = 1000;
const GET_BY_IDS_BATCH = 20;
const HISTORY_WINDOW = 8;
const SID_RE = /^[A-Za-z0-9-]{8,64}$/;
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 8;

const paperKey = (sid: string, file: string) => `s:${sid}:paper:${file}`;
const paperPrefix = (sid: string) => `s:${sid}:paper:`;

type Vars = { sid: string; email: string; token: string };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

/** Surface unhandled errors as JSON so the UI (and debugging) sees the cause. */
app.onError((err, c) => {
  console.error("unhandled error:", err);
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
});

/** Resolve the Bearer token to an email; null when missing/invalid. */
async function authenticate(
  c: { env: Env; req: { header(name: string): string | undefined } },
): Promise<{ email: string; token: string } | null> {
  const header = c.req.header("Authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const email = await resolveToken(c.env, m[1]);
  return email ? { email, token: m[1] } : null;
}

/** Guard: valid session id + authenticated user for every /s/… route. */
const sessionGuard = async (c: any, next: () => Promise<void>) => {
  const sid = c.req.param("sid");
  if (!SID_RE.test(sid)) return c.json({ error: "invalid session id" }, 400);
  const auth = await authenticate(c);
  if (!auth) return c.json({ error: "unauthorized" }, 401);
  c.set("sid", sid);
  c.set("email", auth.email);
  c.set("token", auth.token);
  await next();
};
app.use("/s/:sid/*", sessionGuard);
app.use("/s/:sid", sessionGuard);

/** Guard for account routes that require a login. */
const authGuard = async (c: any, next: () => Promise<void>) => {
  const auth = await authenticate(c);
  if (!auth) return c.json({ error: "unauthorized" }, 401);
  c.set("email", auth.email);
  c.set("token", auth.token);
  await next();
};
app.use("/me/*", authGuard);

// ---------- 帳號 ----------

function sanitizeProfile(p: Partial<UserProfile> | undefined): UserProfile {
  return {
    name: (p?.name ?? "").toString().trim().slice(0, 50),
    school: (p?.school ?? "").toString().trim().slice(0, 100),
    dept: (p?.dept ?? "").toString().trim().slice(0, 100),
    role: (p?.role ?? "").toString().trim().slice(0, 30),
  };
}

/** Register a new account and sign in. */
app.post("/auth/register", async (c) => {
  const { email, password, profile } = await c.req.json<{
    email?: string;
    password?: string;
    profile?: Partial<UserProfile>;
  }>();
  const normEmail = (email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(normEmail)) return c.json({ error: "請輸入有效的電子信箱" }, 400);
  if (!password || password.length < MIN_PASSWORD_LEN) {
    return c.json({ error: `密碼至少需要 ${MIN_PASSWORD_LEN} 個字元` }, 400);
  }
  if (await getUser(c.env, normEmail)) {
    return c.json({ error: "這個信箱已經註冊過了，請直接登入" }, 409);
  }
  const { hash, salt, iterations } = await hashPassword(password);
  const user = {
    pwHash: hash,
    salt,
    iterations,
    profile: sanitizeProfile(profile),
    sessions: [],
    createdAt: Date.now(),
  };
  await putUser(c.env, normEmail, user);
  const token = await issueToken(c.env, normEmail);
  return c.json({ token, email: normEmail, profile: user.profile, sessions: [] });
});

/** Log in with email + password. */
app.post("/auth/login", async (c) => {
  const { email, password } = await c.req.json<{ email?: string; password?: string }>();
  const normEmail = (email ?? "").trim().toLowerCase();
  const user = await getUser(c.env, normEmail);
  // Same error for unknown email and wrong password — no account enumeration.
  if (!user || !password || !(await verifyPassword(password, user.salt, user.pwHash, user.iterations))) {
    return c.json({ error: "帳號或密碼錯誤" }, 401);
  }
  const token = await issueToken(c.env, normEmail);
  return c.json({ token, email: normEmail, profile: user.profile, sessions: user.sessions });
});

/** Log out: revoke the presented token. */
app.post("/auth/logout", authGuard, async (c) => {
  await revokeToken(c.env, c.get("token"));
  return c.json({ ok: true });
});

/** Current account: profile + server-side session list. */
app.get("/auth/me", authGuard, async (c) => {
  const email = c.get("email");
  const user = await getUser(c.env, email);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  return c.json({ email, profile: user.profile, sessions: user.sessions });
});

/** Update profile fields. */
app.put("/auth/profile", authGuard, async (c) => {
  const email = c.get("email");
  const user = await getUser(c.env, email);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const { profile } = await c.req.json<{ profile?: Partial<UserProfile> }>();
  user.profile = sanitizeProfile({ ...user.profile, ...profile });
  await putUser(c.env, email, user);
  return c.json({ profile: user.profile });
});

/** Upsert a session into my list (create/visit/join/rename). */
app.post("/me/sessions", async (c) => {
  const { id, name, role } = await c.req.json<{ id?: string; name?: string; role?: string }>();
  if (!id || !SID_RE.test(id)) return c.json({ error: "a valid session id is required" }, 400);
  const sessions = await upsertUserSession(c.env, c.get("email"), {
    id,
    name: name?.toString().trim().slice(0, 60) || undefined,
    role: role?.toString().trim().slice(0, 20) || undefined,
  });
  return c.json({ sessions: sessions ?? [] });
});

/** Remove a session from my list (server data stays). */
app.delete("/me/sessions/:id", async (c) => {
  const sessions = await removeUserSession(c.env, c.get("email"), c.req.param("id"));
  return c.json({ sessions: sessions ?? [] });
});

/**
 * Q&A within one session's papers, run as a tool-calling agent loop: the
 * model decides which tools to call (list_papers / get_paper_card /
 * search_passages) and how many rounds, then streams its grounded answer.
 * History lives server-side in the chat record. SSE by default (events:
 * tool / meta / delta / done); JSON when stream:false. The completed turn
 * (user + assistant messages) is persisted back to the chat record.
 */
app.post("/s/:sid/chat", async (c) => {
  const sid = c.req.param("sid");
  const { chatId, message, stream = true } = await c.req.json<{
    chatId?: string;
    message?: string;
    stream?: boolean;
  }>();

  if (!message || typeof message !== "string") {
    return c.json({ error: "message is required" }, 400);
  }
  if (!chatId || !ID_RE.test(chatId)) {
    return c.json({ error: "chatId is required" }, 400);
  }

  const record = await loadChat(c.env, sid, chatId);
  const history: ChatMessage[] = (record?.messages ?? [])
    .slice(-HISTORY_WINDOW)
    .map((m) => ({ role: m.role, content: m.content }));
  const messages = buildAgentMessages(message, history);

  // Stored citations carry the retrieved passage so hover previews survive reload.
  const persistTurn = async (result: AgentResult) => {
    await appendMessages(c.env, sid, chatId, [
      { role: "user", content: message },
      {
        role: "assistant",
        content: result.answer,
        citations: attachQuotes(result.citations, result.contexts),
      },
    ]);
  };

  if (stream === false) {
    const result = await runAgent(c.env, sid, messages, () => {});
    await persistTurn(result);
    return c.json({ answer: result.answer, citations: result.citations, contexts: result.contexts });
  }

  const encoder = new TextEncoder();
  const env = c.env;
  const sse = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      try {
        const result = await runAgent(env, sid, messages, (e) => {
          if (e.type === "delta") send("delta", { text: e.text });
          else if (e.type === "meta") send("meta", { citations: e.citations, contexts: e.contexts });
          else send("tool", { name: e.name, args: e.args });
        });
        await persistTurn(result);
        send("done", {});
      } catch (e) {
        send("error", { message: e instanceof Error ? e.message : String(e) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(sse, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
});

/** List this session's papers with summaries. */
app.get("/s/:sid/papers", async (c) => {
  const sid = c.req.param("sid");
  const prefix = paperPrefix(sid);
  const list = await c.env.PAPERS_KV.list({ prefix });
  const papers = await Promise.all(
    list.keys.map(async (k) => {
      const file = k.name.slice(prefix.length);
      const m = parseManifest(await c.env.PAPERS_KV.get(k.name), file);
      return { file, title: m.title, summary: m.summary, ...(m.card ? { card: m.card } : {}) };
    }),
  );
  return c.json({ papers });
});

/** Upload a PDF into this session: parse → chunk → embed → summarize → record. */
app.post("/s/:sid/ingest", async (c) => {
  const sid = c.req.param("sid");
  const form = await c.req.formData();
  const file = form.get("file") as unknown as
    | { arrayBuffer(): Promise<ArrayBuffer>; name: string }
    | null;
  if (!file || typeof file.arrayBuffer !== "function") {
    return c.json({ error: "a PDF 'file' field is required" }, 400);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const pages = await extractPdfPages(bytes);
  const title = (form.get("title")?.toString() || file.name.replace(/\.pdf$/i, "")).trim();

  const records = await buildVectorRecords(
    pages,
    { sourceFile: file.name, title, sessionId: sid },
    (texts) => embedTexts(c.env, texts),
  );
  if (records.length === 0) {
    return c.json({ error: "no extractable text in PDF" }, 422);
  }

  await c.env.VECTORIZE.upsert(records as unknown as VectorizeVector[]);
  const manifest = { title, summary: "", chunkIds: records.map((r) => r.id) };
  const key = paperKey(sid, file.name);
  await c.env.PAPERS_KV.put(key, JSON.stringify(manifest), { metadata: { title } });

  // The structured card is map-reduce over the whole paper (up to 9 LLM
  // calls) — far too slow to block the upload response on. Generate it in
  // the background and patch the manifest when it lands.
  const env = c.env;
  c.executionCtx.waitUntil(
    (async () => {
      const card = await generatePaperCard(env, title, pages);
      const summary = card?.overview ?? (await summarizePaper(env, title, pages.slice(0, 3)));
      // The paper may have been deleted while we were generating — don't resurrect it.
      if ((await env.PAPERS_KV.get(key)) == null) return;
      await env.PAPERS_KV.put(
        key,
        JSON.stringify({ ...manifest, summary, ...(card ? { card } : {}) }),
        { metadata: { title } },
      );
    })(),
  );

  return c.json({ added: records.length, title, file: file.name, summary: "", cardPending: true });
});

/** Delete one paper from this session (vectors + manifest). */
app.delete("/s/:sid/papers/:file", async (c) => {
  const sid = c.req.param("sid");
  const file = decodeURIComponent(c.req.param("file"));
  const key = paperKey(sid, file);
  const raw = await c.env.PAPERS_KV.get(key);
  if (raw == null) {
    return c.json({ error: "paper not found" }, 404);
  }
  const manifest = parseManifest(raw, file);
  for (let i = 0; i < manifest.chunkIds.length; i += DELETE_BATCH) {
    await c.env.VECTORIZE.deleteByIds(manifest.chunkIds.slice(i, i + DELETE_BATCH));
  }
  await c.env.PAPERS_KV.delete(key);
  return c.json({ deleted: file, removedChunks: manifest.chunkIds.length });
});

/**
 * (Re)generate a paper's structured card from its stored chunk vectors —
 * lets papers ingested before the card feature get one without re-uploading.
 */
app.post("/s/:sid/papers/:file/card", async (c) => {
  const sid = c.req.param("sid");
  const file = decodeURIComponent(c.req.param("file"));
  const key = paperKey(sid, file);
  const raw = await c.env.PAPERS_KV.get(key);
  if (raw == null) {
    return c.json({ error: "paper not found" }, 404);
  }
  const manifest = parseManifest(raw, file);

  // Reconstruct approximate page texts from the chunk metadata (chunks
  // overlap, so pages read slightly duplicated — fine for summarization).
  const byPage = new Map<number, Array<{ idx: number; text: string }>>();
  for (let i = 0; i < manifest.chunkIds.length; i += GET_BY_IDS_BATCH) {
    const vectors = await c.env.VECTORIZE.getByIds(
      manifest.chunkIds.slice(i, i + GET_BY_IDS_BATCH),
    );
    for (const v of vectors ?? []) {
      const md = v.metadata as unknown as ChunkMetadata | undefined;
      if (!md || typeof md.text !== "string" || typeof md.page !== "number") continue;
      const idx = Number(String(v.id).match(/::c(\d+)$/)?.[1] ?? 0);
      const chunks = byPage.get(md.page) ?? [];
      chunks.push({ idx, text: md.text });
      byPage.set(md.page, chunks);
    }
  }
  const pages: PdfPage[] = [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([page, chunks]) => ({
      page,
      text: chunks
        .sort((a, b) => a.idx - b.idx)
        .map((ch) => ch.text)
        .join("\n"),
    }));
  if (pages.length === 0) {
    return c.json({ error: "no stored text for this paper" }, 422);
  }

  const card = await generatePaperCard(c.env, manifest.title, pages);
  if (!card) {
    return c.json({ error: "card generation failed" }, 502);
  }
  const updated = { ...manifest, summary: card.overview, card };
  await c.env.PAPERS_KV.put(key, JSON.stringify(updated), { metadata: { title: manifest.title } });
  return c.json({ card, summary: card.overview });
});

/** List this session's chat rooms (most recently active first). */
app.get("/s/:sid/chats", async (c) => {
  const chats = await listChats(c.env, c.req.param("sid"));
  return c.json({ chats });
});

/** Create a chat room. The client supplies the id (uuid). */
app.post("/s/:sid/chats", async (c) => {
  const sid = c.req.param("sid");
  const { id } = await c.req.json<{ id?: string }>().catch(() => ({ id: undefined }));
  if (!id || !ID_RE.test(id)) return c.json({ error: "a valid chat id is required" }, 400);
  const rec = await newChat(c.env, sid, id);
  return c.json({ id, title: rec.title, createdAt: rec.createdAt });
});

/** Full chat record (messages + citations) for restoring the UI. */
app.get("/s/:sid/chats/:chatId", async (c) => {
  const rec = await loadChat(c.env, c.req.param("sid"), c.req.param("chatId"));
  if (!rec) return c.json({ error: "chat not found" }, 404);
  return c.json(rec);
});

/** Delete a chat room. */
app.delete("/s/:sid/chats/:chatId", async (c) => {
  const sid = c.req.param("sid");
  const chatId = c.req.param("chatId");
  await c.env.PAPERS_KV.delete(chatKey(sid, chatId));
  return c.json({ deleted: chatId });
});

/** Delete the entire session: all vectors and all KV keys under s:{sid}:. */
app.delete("/s/:sid", async (c) => {
  const sid = c.req.param("sid");

  const paperList = await c.env.PAPERS_KV.list({ prefix: paperPrefix(sid) });
  const chunkIds: string[] = [];
  for (const k of paperList.keys) {
    const m = parseManifest(await c.env.PAPERS_KV.get(k.name), k.name);
    chunkIds.push(...m.chunkIds);
  }
  for (let i = 0; i < chunkIds.length; i += DELETE_BATCH) {
    await c.env.VECTORIZE.deleteByIds(chunkIds.slice(i, i + DELETE_BATCH));
  }

  const chatList = await c.env.PAPERS_KV.list({ prefix: chatPrefix(sid) });
  const allKeys = [...paperList.keys, ...chatList.keys].map((k) => k.name);
  await Promise.all(allKeys.map((k) => c.env.PAPERS_KV.delete(k)));

  return c.json({ deleted: sid, removedChunks: chunkIds.length, removedKeys: allKeys.length });
});

/** Everything else → static UI from the ASSETS binding. */
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
