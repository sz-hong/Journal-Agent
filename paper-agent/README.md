# Paper Reading Agent

A paper-reading & organizing AI agent over the facial-recognition papers, built **Cloudflare-native**:
**TypeScript + Cloudflare Worker + Vectorize + OpenAI**, with a lightweight web chat UI served by the Worker.

Capabilities:
- **Sessions** — every workspace is an isolated session (`#/s/{sid}`, shareable URL): its own papers, its own chats. A new session starts empty; papers are user-uploaded. Sessions can be deleted wholesale.
- **Multiple chat rooms per session** — chats live in server KV (cross-device); titles auto-set from the first question.
- **Q&A with citations** — answers are grounded in retrieved passages and cite `(Title, p.N)`, streamed token-by-token (SSE).
- **Agentic multi-query retrieval** — each question is rewritten (using server-side chat history) into 1–3 standalone English search queries; retrieval is session-filtered, merged, deduped.
- **Read a new paper** — upload a PDF (real upload progress bar); parsed, embedded, **auto-summarized in Traditional Chinese**.
- **Delete** — per paper, per chat room, or the whole session (vectors + KV).

## Architecture

```
Browser (public/index.html — 3-view SPA: #/ entry · #/s/{sid} session home · #/s/{sid}/c/{chatId} chat)
   │ fetch / SSE
Cloudflare Worker (Hono, src/index.ts) — all routes session-scoped under /s/:sid
   ├── POST   /s/:sid/chat            {chatId, message} → history from KV → plan queries →
   │                                  embed×N → Vectorize (filter session_id) → merge →
   │                                  SSE meta{citations} → delta* → done; turn persisted to KV
   ├── GET    /s/:sid/chats           list chat rooms   POST /s/:sid/chats  create (client uuid)
   ├── GET    /s/:sid/chats/:chatId   full messages     DELETE …/chats/:chatId  remove
   ├── POST   /s/:sid/ingest          upload PDF → chunk → embed → zh-Hant summary →
   │                                  upsert (session-scoped ids) → KV s:{sid}:paper:{file}
   ├── GET    /s/:sid/papers          list papers+summaries   DELETE …/papers/:file  remove
   └── DELETE /s/:sid                 wipe the whole session (vectors + KV keys)
Bindings: VECTORIZE · PAPERS_KV · ASSETS   Secret: OPENAI_API_KEY
Models: text-embedding-3-large (truncated to 1536 dims — Vectorize max) · gpt-5.4 (wrangler.jsonc vars)
KV keys: s:{sid}:paper:{file} → {title, summary, chunkIds} · s:{sid}:chat:{chatId} → {title, timestamps, messages}
```

Only OpenAI calls are billed (embeddings + generation). Cloudflare Vectorize/KV/Workers have free-tier allowances.

## One-time setup

```powershell
cd paper-agent
npm install

# 1) Cloudflare login (opens browser)
npx wrangler login

# 2) Create the vector index and the KV namespace.
#    1536 is Vectorize's max dimension; text-embedding-3-large (native 3072)
#    is truncated to 1536 via the OpenAI `dimensions` parameter.
npx wrangler vectorize create paper-index --dimensions=1536 --metric=cosine
#    Session isolation relies on a metadata index — create it BEFORE inserting vectors:
npx wrangler vectorize create-metadata-index paper-index --property-name=session_id --type=string
npx wrangler kv namespace create PAPERS_KV
#    → copy the printed `id` into wrangler.jsonc (kv_namespaces[0].id)

# 3) OpenAI key
#    local dev:  copy .dev.vars.example -> .dev.vars and fill OPENAI_API_KEY
#    production: npx wrangler secret put OPENAI_API_KEY
```

## Bulk-ingest local PDFs into a session

```powershell
# Create a session in the web UI (or generate a uuid), copy its id, then:
npm run ingest -- --session <sid>    # embeds ../*.pdf into that session
# or add --no-run to only write data/ files and print the wrangler commands
npx wrangler vectorize info paper-index   # confirm vector count
```

## Run & deploy

```powershell
npm test        # vitest — the TDD suite
npm run dev     # local: wrangler dev  → open the printed http://localhost:8787
npm run deploy  # production: wrangler deploy → *.workers.dev URL
```

## Layout

```
paper-agent/
├── src/
│   ├── index.ts        Hono session-scoped routes (/s/:sid/…: chat SSE, chats CRUD, papers, ingest, session wipe)
│   ├── chats.ts        KV chat store (newChat / loadChat / appendMessages / listChats)
│   ├── openai.ts       embed() / chat() / chatStream() wrappers
│   ├── plan.ts         planQueries — history-aware query rewriting (1–3 standalone queries)
│   ├── retrieval.ts    Vectorize query (session_id filter) → contexts; mergeContexts (dedupe + cap)
│   ├── prompt.ts       grounded, cite-or-say-unknown, plain-text-only system prompt
│   ├── summary.ts      summarizePaper — zh-Hant auto-summary at ingest time
│   ├── manifest.ts     parseManifest — KV value JSON {title, summary, chunkIds}
│   ├── chunk.ts        chunkText (size 1000 / overlap 200)
│   ├── citations.ts    dedup citations
│   ├── ingest-core.ts  pages → chunks → vector records (ids = fnv1a(sid::file)::pN::cM, session_id metadata)
│   ├── pdf.ts          unpdf per-page text extraction
│   └── types.ts        Env + shared types
├── scripts/ingest.ts   local bulk ingest into a session (--session <sid>)
├── public/index.html   3-view SPA (entry · session home · chat room)
└── test/*.test.ts      TDD suite (pure units + mocked Worker routes)
```

## Notes
- Tests run in plain Node with hand-injected mock bindings (Vectorize has no local test emulation); real bindings are exercised via `wrangler dev` / `deploy`.
- Switching the embedding model means changing `OPENAI_EMBED_MODEL`, recreating the index at the new dimension, and re-ingesting.
- `/chat` and `/ingest` are unauthenticated in v1 — add auth/rate-limiting before exposing publicly.
- The `../rag/` Python project is legacy (local all-MiniLM embeddings), superseded by this Worker.
