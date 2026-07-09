# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A research/writing project on **facial recognition techniques** that has grown a software component:
a **paper-reading AI agent** over the collection of reference PDFs.

## Contents

- **6 reference PDFs** — facial-recognition literature (techniques, disease-diagnosis applications,
  attendance systems, policing/regulation, societal impact, ethics). **Local only — gitignored**,
  not published to GitHub (copyright).
- `outline.md` — per-paper summaries of all 6 papers plus a cross-paper comparison.
- `paper-agent/` — **primary app**: a Cloudflare-native TypeScript agent (Worker + Vectorize + OpenAI)
  that answers questions, compares papers, and ingests new PDFs, with a web chat UI. See
  [paper-agent/README.md](paper-agent/README.md).
- `rag/` — **legacy**: an earlier local Python RAG (ChromaDB + local `all-MiniLM` embeddings), free and
  offline but superseded by `paper-agent/` (which uses OpenAI embeddings + Cloudflare Vectorize).

## paper-agent (the app)

Stack: TypeScript · Cloudflare Workers (Hono) · Cloudflare Vectorize · OpenAI (`text-embedding-3-large`
truncated to 1536 dims + `gpt-5.4`). Local embeddings are **not** used here — both embeddings and generation go through OpenAI.
Tests are written test-first (Vitest) in plain Node with hand-injected mock bindings.

Common commands (run from `paper-agent/`):

```
npm install
npm test                 # vitest — the TDD suite (22 tests)
npm run typecheck        # tsc --noEmit
npm run dev              # wrangler dev (local)
npm run deploy           # wrangler deploy (production)
npm run ingest           # bulk-embed ../*.pdf → Vectorize + KV
```

First-time setup (login, create `paper-index` Vectorize index + `PAPERS_KV`, set `OPENAI_API_KEY`) is in
[paper-agent/README.md](paper-agent/README.md).

Key layout: **everything is session-scoped** — routes live under `/s/:sid/…` in `src/index.ts`
(chat SSE meta/delta/done with `{stream:false}` JSON fallback; chats CRUD; papers list/ingest/delete;
`DELETE /s/:sid` wipes a whole session). Chat history is **server-side** in KV
(`src/chats.ts`: key `s:{sid}:chat:{chatId}`); paper manifests at `s:{sid}:paper:{file}`
(`src/manifest.ts`). Retrieval filters Vectorize by `session_id` metadata (`src/retrieval.ts`) —
the index needs a `session_id` metadata index created **before** any inserts. Vector ids hash
`sid::filename` (`src/ingest-core.ts`) so same-named files in different sessions never collide.
Query planning in `src/plan.ts`; OpenAI wrappers (`chat`, `chatStream`) in `src/openai.ts`;
zh-Hant auto-summaries in `src/summary.ts`; prompt (grounded + plain-text-only) in `src/prompt.ts`;
chunking in `src/chunk.ts` (1000/200); PDF parsing (unpdf) in `src/pdf.ts`. The UI is a 3-view SPA in
`public/index.html`: `#/` entry (create/join sessions; known sessions in localStorage),
`#/s/{sid}` session home (papers + chat rooms + upload progress bar), `#/s/{sid}/c/{chatId}` chat.
Bulk ingest: `npm run ingest -- --session <sid>`.

### Conventions
- **Secrets**: `OPENAI_API_KEY` lives in `paper-agent/.dev.vars` (gitignored) for local dev and in a
  `wrangler secret` for production. Never hard-code it or commit it.
- **TDD**: add or update a test in `test/` before changing behavior; keep `npm test` and `npm run typecheck`
  green. Handler tests mock the OpenAI `fetch` and the Vectorize/KV bindings.
- **Grounding**: the agent must answer only from retrieved context and cite `(Title, p.N)` — do not
  fabricate claims, statistics, or citations (see `src/prompt.ts`).

## Writing / research conventions
- When drafting sections, cite findings from the PDFs accurately — do not fabricate claims or statistics.
- Prose output goes in Markdown (`outline.md` or additional `.md` files).
