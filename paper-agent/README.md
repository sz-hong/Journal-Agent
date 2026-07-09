# Paper Reading Agent

A paper-reading & organizing AI agent over the facial-recognition papers, built **Cloudflare-native**:
**TypeScript + Cloudflare Worker + Vectorize + OpenAI**, with a lightweight web chat UI served by the Worker.

Capabilities:
- **Q&A with citations** — ask about the indexed papers; answers are grounded in retrieved passages and cite `(Title, p.N)`, streamed token-by-token (SSE).
- **Agentic multi-query retrieval** — each question is rewritten (using conversation history) into 1–3 standalone English search queries; results are merged and deduped, so follow-ups ("那第二篇呢?") and multi-part questions retrieve well.
- **Conversation memory** — history is threaded into the prompt and persisted in the browser (localStorage) with a clear-chat button.
- **Read a new paper** — upload a PDF (with a real upload progress bar); it's parsed, embedded, **auto-summarized in Traditional Chinese**, and added to the index on the fly.
- **Delete a paper** — remove a paper's vectors + manifest from the home-page card.

## Architecture

```
Browser (public/index.html — two-view SPA: #/ home · #/chat chat room)
   │ fetch / SSE
Cloudflare Worker (Hono, src/index.ts)
   ├── POST   /chat          plan queries (history-aware) → embed×N → Vectorize → merge
   │                         → grounded prompt → SSE: meta{citations} → delta* → done
   │                         (body {stream:false} → single JSON {answer, citations, contexts, queries})
   ├── POST   /ingest        upload PDF → unpdf → chunk → OpenAI embed → zh-Hant summary
   │                         → Vectorize upsert → KV manifest {title, summary, chunkIds}
   ├── GET    /papers        list ingested papers with summaries (KV)
   └── DELETE /papers/:file  deleteByIds(chunkIds) + remove KV manifest
Bindings: VECTORIZE · PAPERS_KV · ASSETS   Secret: OPENAI_API_KEY
Models: text-embedding-3-large (truncated to 1536 dims — Vectorize max) · gpt-5.4 (wrangler.jsonc vars)
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
npx wrangler kv namespace create PAPERS_KV
#    → copy the printed `id` into wrangler.jsonc (kv_namespaces[0].id)

# 3) OpenAI key
#    local dev:  copy .dev.vars.example -> .dev.vars and fill OPENAI_API_KEY
#    production: npx wrangler secret put OPENAI_API_KEY
```

## Ingest the 6 papers

```powershell
npm run ingest          # embeds ../*.pdf, then inserts into Vectorize + KV
# or: npm run ingest -- --no-run   # only writes data/ files, prints the wrangler commands
npx wrangler vectorize info paper-index   # confirm vector count (~528)
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
│   ├── index.ts        Hono routes (/chat SSE, /papers, /ingest, DELETE /papers/:file, static UI)
│   ├── openai.ts       embed() / chat() / chatStream() wrappers
│   ├── plan.ts         planQueries — history-aware query rewriting (1–3 standalone queries)
│   ├── retrieval.ts    Vectorize query → contexts; mergeContexts (dedupe + cap)
│   ├── prompt.ts       grounded, cite-or-say-unknown, plain-text-only system prompt
│   ├── summary.ts      summarizePaper — zh-Hant auto-summary at ingest time
│   ├── manifest.ts     parseManifest — KV value JSON {title, summary, chunkIds} (+ legacy fallback)
│   ├── chunk.ts        chunkText (size 1000 / overlap 200)
│   ├── citations.ts    dedup citations
│   ├── ingest-core.ts  pages → chunks → vector records (ids = fnv1a(file)::pN::cM)
│   ├── pdf.ts          unpdf per-page text extraction
│   └── types.ts        Env + shared types
├── scripts/ingest.ts   local bulk ingest (embeds + summarizes + writes KV manifests)
├── public/index.html   two-view SPA (home: cards/upload-progress · chat: SSE streaming)
└── test/*.test.ts      TDD suite (pure units + mocked Worker routes)
```

## Notes
- Tests run in plain Node with hand-injected mock bindings (Vectorize has no local test emulation); real bindings are exercised via `wrangler dev` / `deploy`.
- Switching the embedding model means changing `OPENAI_EMBED_MODEL`, recreating the index at the new dimension, and re-ingesting.
- `/chat` and `/ingest` are unauthenticated in v1 — add auth/rate-limiting before exposing publicly.
- The `../rag/` Python project is legacy (local all-MiniLM embeddings), superseded by this Worker.
