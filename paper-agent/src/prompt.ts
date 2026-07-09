import type { RetrievedContext, ChatMessage } from "./types";

const SYSTEM_PROMPT = `You are a research assistant that answers questions about a collection of academic papers on facial recognition.

Rules:
- Answer ONLY using the provided context passages. Do not use outside knowledge or invent facts, statistics, or citations.
- Cite your sources inline as (Title, p.PAGE) using the titles and page numbers given in the context.
- If the context does not contain the answer, say you don't know / it is not covered in the indexed papers.
- When asked to compare papers, synthesize across the different sources and attribute each point.
- Be concise and precise.
- Answer in plain text only. Do NOT use Markdown formatting: no **bold**, no ## headings, no backticks, no tables, no bullet symbols. When listing, use simple numbered lines (1. 2. 3.).`;

/** Render retrieved passages into a numbered, citable block. */
function formatContexts(contexts: RetrievedContext[]): string {
  if (contexts.length === 0) return "(no relevant passages found)";
  return contexts
    .map((c, i) => `[${i + 1}] ${c.title} (p.${c.page})\n${c.text}`)
    .join("\n\n");
}

/**
 * Build the OpenAI chat message array: system rules, prior history, then a
 * user turn carrying the retrieved context block plus the question.
 */
export function buildChatMessages(
  question: string,
  contexts: RetrievedContext[],
  history: ChatMessage[] = [],
): ChatMessage[] {
  const userContent = `Context:\n${formatContexts(contexts)}\n\nQuestion: ${question}`;
  return [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: userContent },
  ];
}
