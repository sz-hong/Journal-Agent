import { Hono } from "hono";
import type { Env } from "./types";
import { embedQuery, embedTexts, chat } from "./openai";
import { queryContexts } from "./retrieval";
import { buildChatMessages } from "./prompt";
import { extractCitations } from "./citations";
import { extractPdfPages } from "./pdf";
import { buildVectorRecords } from "./ingest-core";

const app = new Hono<{ Bindings: Env }>();

/** Q&A + cross-paper comparison: embed → retrieve → grounded generation. */
app.post("/chat", async (c) => {
  const { message, history = [], k = 6 } = await c.req.json<{
    message?: string;
    history?: { role: "user" | "assistant"; content: string }[];
    k?: number;
  }>();

  if (!message || typeof message !== "string") {
    return c.json({ error: "message is required" }, 400);
  }

  const queryVector = await embedQuery(c.env, message);
  const contexts = await queryContexts(c.env, queryVector, k);
  const messages = buildChatMessages(message, contexts, history);
  const answer = await chat(c.env, messages);

  return c.json({ answer, citations: extractCitations(contexts), contexts });
});

/** List papers that have been ingested into the index. */
app.get("/papers", async (c) => {
  const list = await c.env.PAPERS_KV.list();
  const papers = list.keys.map((k) => ({
    file: k.name,
    title: (k.metadata as { title?: string } | undefined)?.title ?? k.name,
  }));
  return c.json({ papers });
});

/** Read a new paper: upload a PDF → parse → chunk → embed → upsert → record. */
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

  await c.env.VECTORIZE.upsert(records as unknown as VectorizeVector[]);
  await c.env.PAPERS_KV.put(file.name, title, { metadata: { title } });

  return c.json({ added: records.length, title, file: file.name });
});

/** Everything else → static chat UI from the ASSETS binding. */
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
