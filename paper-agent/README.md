# Paper Reading Agent

A paper-reading & organizing AI agent over the facial-recognition papers, built **Cloudflare-native**:
**TypeScript + Cloudflare Worker + Vectorize + OpenAI**, with a lightweight web chat UI served by the Worker.

Capabilities:
- **Q&A with citations** — ask about the indexed papers; answers are grounded in retrieved passages and cite `(Title, p.N)`.
- **Cross-paper compare/synthesize** — ask comparative questions; the agent draws on multiple papers.
- **Read a new paper** — upload a PDF in the UI; it's parsed, embedded, and added to the index on the fly.

## Architecture

```
Browser (public/index.html)
   │ fetch
Cloudflare Worker (Hono, src/index.ts)
   ├── POST /chat    embed query → Vectorize topK → grounded prompt → OpenAI chat → {answer, citations}
   ├── POST /ingest  upload PDF → unpdf → chunk → OpenAI embed → Vectorize upsert → KV record
   └── GET  /papers  list ingested papers (KV)
Bindings: VECTORIZE · PAPERS_KV · ASSETS   Secret: OPENAI_API_KEY
Models: text-embedding-3-small · gpt-4o-mini (configurable in wrangler.jsonc vars)
```

Only OpenAI calls are billed (embeddings + generation). Cloudflare Vectorize/KV/Workers have free-tier allowances.

## One-time setup

```powershell
cd paper-agent
npm install

# 1) Cloudflare login (opens browser)
npx wrangler login

# 2) Create the vector index (1536 dims = text-embedding-3-small) and the KV namespace
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
npm test        # 22 tests (vitest) — the TDD suite
npm run dev     # local: wrangler dev  → open the printed http://localhost:8787
npm run deploy  # production: wrangler deploy → *.workers.dev URL
```

## Layout

```
paper-agent/
├── src/
│   ├── index.ts        Hono routes (/chat, /papers, /ingest, static UI)
│   ├── openai.ts       embed() / chat() wrappers
│   ├── retrieval.ts    Vectorize query → contexts
│   ├── prompt.ts       grounded, cite-or-say-unknown system prompt
│   ├── chunk.ts        chunkText (size 1000 / overlap 200)
│   ├── citations.ts    dedup citations
│   ├── ingest-core.ts  pages → chunks → vector records
│   ├── pdf.ts          unpdf per-page text extraction
│   └── types.ts        Env + shared types
├── scripts/ingest.ts   local bulk ingest
├── public/index.html   chat UI
└── test/*.test.ts      TDD suite (pure units + mocked Worker routes)
```

## Notes
- Tests run in plain Node with hand-injected mock bindings (Vectorize has no local test emulation); real bindings are exercised via `wrangler dev` / `deploy`.
- Switching the embedding model means changing `OPENAI_EMBED_MODEL`, recreating the index at the new dimension, and re-ingesting.
- `/chat` and `/ingest` are unauthenticated in v1 — add auth/rate-limiting before exposing publicly.
- The `../rag/` Python project is legacy (local all-MiniLM embeddings), superseded by this Worker.
