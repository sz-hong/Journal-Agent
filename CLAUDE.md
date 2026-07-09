# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A research/writing project on **facial recognition techniques** that has grown a software component:
a **paper-reading AI agent** over the collection of reference PDFs.

## Contents

- **6 reference PDFs** — facial-recognition literature (techniques, disease-diagnosis applications,
  attendance systems, policing/regulation, societal impact, ethics).
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

Key layout: routes in `src/index.ts`; OpenAI wrappers in `src/openai.ts`; retrieval in `src/retrieval.ts`;
chunking in `src/chunk.ts` (size 1000 / overlap 200); prompt in `src/prompt.ts`; PDF parsing (unpdf) in
`src/pdf.ts`. The chat UI is `public/index.html` (served via the ASSETS binding).

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
