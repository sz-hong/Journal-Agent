import { Hono } from "hono";
import type { Env, ChatMessage, Citation } from "./types";
import { embedQuery, embedTexts, chat, chatStream } from "./openai";
import { queryContexts, mergeContexts } from "./retrieval";
import { buildChatMessages } from "./prompt";
import { extractCitations } from "./citations";
import { extractPdfPages } from "./pdf";
import { buildVectorRecords } from "./ingest-core";
import { planQueries } from "./plan";
import { summarizePaper } from "./summary";
import { parseManifest } from "./manifest";
import { chatKey, chatPrefix, newChat, loadChat, appendMessages, listChats } from "./chats";

const PER_QUERY_K = 5;
const DELETE_BATCH = 1000;
const HISTORY_WINDOW = 8;
const SID_RE = /^[A-Za-z0-9-]{8,64}$/;
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

const paperKey = (sid: string, file: string) => `s:${sid}:paper:${file}`;
const paperPrefix = (sid: string) => `s:${sid}:paper:`;

const app = new Hono<{ Bindings: Env; Variables: { sid: string } }>();

/** Validate the session id once for every session-scoped route. */
app.use("/s/:sid/*", async (c, next) => {
  const sid = c.req.param("sid");
  if (!SID_RE.test(sid)) return c.json({ error: "invalid session id" }, 400);
  c.set("sid", sid);
  await next();
});
app.use("/s/:sid", async (c, next) => {
  const sid = c.req.param("sid");
  if (!SID_RE.test(sid)) return c.json({ error: "invalid session id" }, 400);
  c.set("sid", sid);
  await next();
});

/**
 * Q&A within one session's papers. History lives server-side in the chat
 * record. Pipeline: plan queries → retrieve (session-filtered) → merge →
 * grounded generation. SSE by default; JSON when stream:false. The completed
 * turn (user + assistant messages) is persisted back to the chat record.
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

  const queries = await planQueries(c.env, message, history);
  const lists = await Promise.all(
    queries.map(async (q) => {
      const vec = await embedQuery(c.env, q);
      return queryContexts(c.env, vec, PER_QUERY_K, sid);
    }),
  );
  const contexts = mergeContexts(lists);
  const citations = extractCitations(contexts);
  const messages = buildChatMessages(message, contexts, history);

  const persistTurn = async (answer: string, cites: Citation[]) => {
    await appendMessages(c.env, sid, chatId, [
      { role: "user", content: message },
      { role: "assistant", content: answer, citations: cites },
    ]);
  };

  if (stream === false) {
    const answer = await chat(c.env, messages);
    await persistTurn(answer, citations);
    return c.json({ answer, citations, contexts, queries });
  }

  const encoder = new TextEncoder();
  const env = c.env;
  const sse = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      send("meta", { citations, contexts, queries });
      try {
        let answer = "";
        for await (const text of chatStream(env, messages)) {
          answer += text;
          send("delta", { text });
        }
        await persistTurn(answer, citations);
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
      return { file, title: m.title, summary: m.summary };
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

  const summary = await summarizePaper(c.env, title, pages.slice(0, 3));

  await c.env.VECTORIZE.upsert(records as unknown as VectorizeVector[]);
  const manifest = { title, summary, chunkIds: records.map((r) => r.id) };
  await c.env.PAPERS_KV.put(paperKey(sid, file.name), JSON.stringify(manifest), {
    metadata: { title },
  });

  return c.json({ added: records.length, title, file: file.name, summary });
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
