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
  /** Embedding model id, e.g. "text-embedding-3-large". */
  OPENAI_EMBED_MODEL: string;
  /**
   * Optional output dimension for embedding-3 models (Matryoshka truncation).
   * Vectorize caps indexes at 1536 dims, so text-embedding-3-large (native
   * 3072) must be truncated: set this to "1536". Omit to use the model's default.
   */
  OPENAI_EMBED_DIMENSIONS?: string;
  /**
   * Optional OpenAI-compatible base URL (no trailing slash). Set to a
   * Cloudflare AI Gateway endpoint to avoid OpenAI regional blocks:
   * https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/openai
   */
  OPENAI_BASE_URL?: string;
  /** Token for an authenticated AI Gateway (sent as cf-aig-authorization). */
  CF_AIG_TOKEN?: string;
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
  /** Owning session — retrieval filters on this (metadata index required). */
  session_id: string;
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

/** KV manifest value (stored as JSON) describing one ingested paper. */
export interface PaperManifest {
  title: string;
  /** Traditional-Chinese auto-summary generated at ingest time ("" if none). */
  summary: string;
  /** Vector ids of every chunk, recorded so the paper can be deleted. */
  chunkIds: string[];
}

/** One message stored in a chat record (citations kept for UI restore only). */
export interface StoredChatMessage {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
}

/** KV chat record (key s:{sid}:chat:{chatId}, stored as JSON). */
export interface ChatRecord {
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: StoredChatMessage[];
}

/** One page of extracted PDF text. */
export interface PdfPage {
  page: number;
  text: string;
}
