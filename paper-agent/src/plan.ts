import type { Env, ChatMessage } from "./types";
import { chat } from "./openai";

const MAX_QUERIES = 3;

const PLANNER_PROMPT = `You turn a user's question about a collection of English academic papers on facial recognition into standalone vector-search queries.

Rules:
- Output ONLY a JSON array of 1 to ${MAX_QUERIES} short English search queries. No prose, no explanation.
- Each query must be self-contained: resolve pronouns/references ("it", "那篇", "the second one") using the conversation history.
- Split multi-part questions into one query per part.
- Keep queries keyword-dense (the papers are in English, so queries must be in English).`;

/**
 * Rewrite the (possibly context-dependent, possibly multi-part) user message
 * into 1-3 standalone English search queries. Falls back to the raw message
 * if the model call fails or returns unparseable output.
 */
export async function planQueries(
  env: Env,
  message: string,
  history: ChatMessage[],
): Promise<string[]> {
  const historyBlock =
    history.length === 0
      ? "(no prior conversation)"
      : history.map((m) => `${m.role}: ${m.content}`).join("\n");

  try {
    const raw = await chat(env, [
      { role: "system", content: PLANNER_PROMPT },
      {
        role: "user",
        content: `Conversation so far:\n${historyBlock}\n\nUser question: ${message}`,
      },
    ]);
    const jsonText = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const parsed = JSON.parse(jsonText);
    if (Array.isArray(parsed)) {
      const queries = parsed
        .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
        .slice(0, MAX_QUERIES);
      if (queries.length > 0) return queries;
    }
  } catch {
    // fall through to the raw message
  }
  return [message];
}
