import { Hono } from "hono";
import type { Env, ChatMessage } from "./types";
import { embedQuery, embedTexts, chat, chatStream } from "./openai";
import { queryContexts, mergeContexts } from "./retrieval";
import { buildChatMessages } from "./prompt";
import { extractCitations } from "./citations";
import { extractPdfPages } from "./pdf";
import { buildVectorRecords } from "./ingest-core";
import { planQueries } from "./plan";
import { summarizePaper } from "./summary";
import { parseManifest } from "./manifest";

const PER_QUERY_K = 5;
const DELETE_BATCH = 1000;

const app = new Hono<{ Bindings: Env }>();

/**
 * Q&A + cross-paper comparison. Pipeline: plan standalone search queries from
 * the message + history → retrieve per query → merge → grounded generation.
 * Responds with SSE (meta → delta* → done) by default; JSON when stream:false.
 */
app.post("/chat", async (c) => {
  const { message, history = [], stream = true } = await c.req.json<{
    message?: string;
    history?: ChatMessage[];
    stream?: boolean;
  }>();

  if (!message || typeof message !== "string") {
    return c.json({ error: "message is required" }, 400);
  }

  const queries = await planQueries(c.env, message, history);
  const lists = await Promise.all(
    queries.map(async (q) => {
      const vec = await embedQuery(c.env, q);
      return queryContexts(c.env, vec, PER_QUERY_K);
    }),
  );
  const contexts = mergeContexts(lists);
  const citations = extractCitations(contexts);
  const messages = buildChatMessages(message, contexts, history);

  if (stream === false) {
    const answer = await chat(c.env, messages);
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
        for await (const text of chatStream(env, messages)) send("delta", { text });
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

/** List ingested papers with their zh-Hant summaries from the KV manifest. */
app.get("/papers", async (c) => {
  const list = await c.env.PAPERS_KV.list();
  const papers = await Promise.all(
    list.keys.map(async (k) => {
      const m = parseManifest(await c.env.PAPERS_KV.get(k.name), k.name);
      return { file: k.name, title: m.title, summary: m.summary };
    }),
  );
  return c.json({ papers });
});

/** Read a new paper: upload a PDF → parse → chunk → embed → summarize → record. */
app.post("/ingest", async (c) => {
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
    { sourceFile: file.name, title },
    (texts) => embedTexts(c.env, texts),
  );
  if (records.length === 0) {
    return c.json({ error: "no extractable text in PDF" }, 422);
  }

  const summary = await summarizePaper(c.env, title, pages.slice(0, 3));

  await c.env.VECTORIZE.upsert(records as unknown as VectorizeVector[]);
  const manifest = { title, summary, chunkIds: records.map((r) => r.id) };
  await c.env.PAPERS_KV.put(file.name, JSON.stringify(manifest), { metadata: { title } });

  return c.json({ added: records.length, title, file: file.name, summary });
});

/** Delete a paper: remove its vectors (by recorded chunk ids) and its manifest. */
app.delete("/papers/:file", async (c) => {
  const file = decodeURIComponent(c.req.param("file"));
  const raw = await c.env.PAPERS_KV.get(file);
  if (raw == null) {
    return c.json({ error: "paper not found" }, 404);
  }
  const manifest = parseManifest(raw, file);
  if (manifest.chunkIds.length === 0) {
    return c.json(
      { error: "no chunk ids recorded for this paper (legacy entry); re-ingest it first" },
      409,
    );
  }
  for (let i = 0; i < manifest.chunkIds.length; i += DELETE_BATCH) {
    await c.env.VECTORIZE.deleteByIds(manifest.chunkIds.slice(i, i + DELETE_BATCH));
  }
  await c.env.PAPERS_KV.delete(file);
  return c.json({ deleted: file, removedChunks: manifest.chunkIds.length });
});

/** Everything else → static chat UI from the ASSETS binding. */
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
