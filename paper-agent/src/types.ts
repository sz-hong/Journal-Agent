/** Shared types for the paper-reading agent. */

/** Cloudflare Worker bindings + vars + secret. */
export interface Env {
  /** Vectorize index holding paper chunk embeddings. */
  VECTORIZE: VectorizeIndex;
  /** KV manifest of ingested papers (key = source file name, value = title). */
  PAPERS_KV: KVNamespace;
  /** Static assets (the chat UI). */
  ASSETS: Fetcher;
  /** OpenAI secret (from .dev.vars locally / wrangler secret in prod). */
  OPENAI_API_KEY: string;
  /** Chat model id, e.g. "gpt-4o-mini". */
  OPENAI_CHAT_MODEL: string;
  /** Embedding model id, e.g. "text-embedding-3-small". */
  OPENAI_EMBED_MODEL: string;
}

/** A single OpenAI chat message. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Metadata stored alongside each vector in Vectorize. */
export interface ChunkMetadata {
  /** The chunk text itself (fed to the LLM at query time). */
  text: string;
  /** Friendly paper title for display/citation. */
  title: string;
  /** 1-indexed page number the chunk came from. */
  page: number;
  /** Original PDF file name. */
  source_file: string;
}

/** A vector ready to upsert into Vectorize. */
export interface VectorRecord {
  id: string;
  values: number[];
  metadata: ChunkMetadata;
}

/** A retrieved chunk with its relevance score, used to build the prompt. */
export interface RetrievedContext {
  text: string;
  title: string;
  page: number;
  sourceFile: string;
  score: number;
}

/** A deduped source reference shown under an answer. */
export interface Citation {
  title: string;
  page: number;
}

/** One page of extracted PDF text. */
export interface PdfPage {
  page: number;
  text: string;
}
