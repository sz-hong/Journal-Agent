import type { AgentMessage, Citation, Env, RetrievedContext, ToolCall } from "./types";
import { chatStreamWithTools } from "./openai";
import { toolDefinitions, executeTool } from "./tools";
import { extractCitations } from "./citations";
import { mergeContexts } from "./retrieval";

/** Hard cap on model rounds; the final round forces an answer. */
export const MAX_ROUNDS = 6;
/** Cap on contexts accumulated across rounds (feeds citations + hover cache). */
const CONTEXT_CAP = 32;

/** Events surfaced to the caller while the loop runs (mapped onto SSE). */
export type AgentEvent =
  | { type: "tool"; name: string; args: Record<string, unknown> }
  | { type: "meta"; citations: Citation[]; contexts: RetrievedContext[] }
  | { type: "delta"; text: string };

export interface AgentResult {
  answer: string;
  contexts: RetrievedContext[];
  citations: Citation[];
}

/**
 * Tool-calling agent loop: stream a completion with tools; execute requested
 * tools and append their results to the transcript; repeat until the model
 * answers in plain content (streamed through as `delta` events) or rounds run
 * out (then `tool_choice:"none"` forces an answer). Search results accumulate
 * (deduped) into the contexts used for citations.
 */
export async function runAgent(
  env: Env,
  sid: string,
  messages: AgentMessage[],
  emit: (e: AgentEvent) => void | Promise<void>,
): Promise<AgentResult> {
  const transcript: AgentMessage[] = [...messages];
  let contexts: RetrievedContext[] = [];
  let answer = "";

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const isLastRound = round === MAX_ROUNDS - 1;
    let calls: ToolCall[] | null = null;
    for await (const ev of chatStreamWithTools(
      env,
      transcript,
      toolDefinitions,
      isLastRound ? "none" : undefined,
    )) {
      if (ev.type === "delta") {
        answer += ev.text;
        await emit({ type: "delta", text: ev.text });
      } else {
        calls = ev.calls;
      }
    }
    if (!calls || calls.length === 0) break;

    transcript.push({
      role: "assistant",
      content: null,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.arguments },
      })),
    });

    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {};
      } catch {
        // surface the raw string when the model produced malformed JSON
        args = { raw: call.arguments };
      }
      await emit({ type: "tool", name: call.name, args });
    }

    const results = await Promise.all(
      calls.map((c) => executeTool(env, sid, c.name, c.arguments)),
    );
    results.forEach((res, i) => {
      transcript.push({ role: "tool", tool_call_id: calls![i].id, content: res.content });
    });

    const retrieved = results.map((r) => r.contexts ?? []).filter((list) => list.length > 0);
    if (retrieved.length > 0) {
      contexts = mergeContexts([contexts, ...retrieved], CONTEXT_CAP);
      await emit({ type: "meta", citations: extractCitations(contexts), contexts });
    }
  }

  return { answer, contexts, citations: extractCitations(contexts) };
}
