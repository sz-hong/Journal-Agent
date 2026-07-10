import type { Env, ChatMessage, AgentMessage, ToolCall, ToolDefinition } from "./types";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** Resolve endpoint + headers, honouring an AI Gateway base URL when set. */
function endpoint(env: Env, path: string): { url: string; headers: Record<string, string> } {
  const base = (env.OPENAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    "Content-Type": "application/json",
  };
  if (env.CF_AIG_TOKEN) headers["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;
  return { url: `${base}${path}`, headers };
}

async function postJson(env: Env, path: string, body: unknown): Promise<any> {
  const { url, headers } = endpoint(env, path);
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      detail = await res.text().catch(() => "");
    }
    throw new Error(`OpenAI request failed (${res.status}): ${detail}`);
  }
  return res.json();
}

/** Embed a batch of texts. Returns one vector per input, in order. */
export async function embedTexts(env: Env, inputs: string[]): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const dims = env.OPENAI_EMBED_DIMENSIONS ? Number(env.OPENAI_EMBED_DIMENSIONS) : undefined;
  const json = await postJson(env, "/embeddings", {
    model: env.OPENAI_EMBED_MODEL,
    input: inputs,
    ...(dims ? { dimensions: dims } : {}),
  });
  return (json.data as Array<{ embedding: number[] }>).map((d) => d.embedding);
}

/** Embed a single query string. */
export async function embedQuery(env: Env, text: string): Promise<number[]> {
  const [vec] = await embedTexts(env, [text]);
  return vec;
}

/** gpt-5 and o-series reasoning models only accept the default temperature. */
function supportsTemperature(model: string): boolean {
  return !/^(gpt-5|o\d)/.test(model);
}

function chatBody(env: Env, messages: readonly AgentMessage[]): Record<string, unknown> {
  return {
    model: env.OPENAI_CHAT_MODEL,
    messages,
    ...(supportsTemperature(env.OPENAI_CHAT_MODEL) ? { temperature: 0.2 } : {}),
  };
}

/** Run a chat completion and return the assistant's message content. */
export async function chat(env: Env, messages: ChatMessage[]): Promise<string> {
  const json = await postJson(env, "/chat/completions", chatBody(env, messages));
  return json.choices?.[0]?.message?.content ?? "";
}

/**
 * Run a streaming chat completion, yielding assistant text deltas as they
 * arrive. Parses OpenAI's SSE format (`data: {...}` lines, `data: [DONE]`).
 */
export async function* chatStream(env: Env, messages: ChatMessage[]): AsyncGenerator<string> {
  const { url, headers } = endpoint(env, "/chat/completions");
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...chatBody(env, messages), stream: true }),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenAI request failed (${res.status}): ${detail}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE events are separated by a blank line; keep the tail in the buffer.
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) {
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          const text = JSON.parse(data).choices?.[0]?.delta?.content;
          if (typeof text === "string" && text.length > 0) yield text;
        } catch {
          // ignore malformed keep-alive/partial lines
        }
      }
    }
  }
}

/** An event from a tool-enabled streaming completion. */
export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "tool_calls"; calls: ToolCall[] };

/**
 * Streaming chat completion with function-calling tools. Yields assistant
 * text as `delta` events; tool-call fragments (OpenAI streams name/arguments
 * split across chunks, keyed by index) are accumulated and flushed as a
 * single `tool_calls` event when the stream ends.
 */
export async function* chatStreamWithTools(
  env: Env,
  messages: readonly AgentMessage[],
  tools: ToolDefinition[],
  toolChoice?: "auto" | "none",
): AsyncGenerator<StreamEvent> {
  const { url, headers } = endpoint(env, "/chat/completions");
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...chatBody(env, messages),
      stream: true,
      tools,
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
    }),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenAI request failed (${res.status}): ${detail}`);
  }

  // Partial tool calls keyed by the stream's tool_calls[].index.
  const pending = new Map<number, { id: string; name: string; arguments: string }>();
  const flush = (): StreamEvent | null => {
    if (pending.size === 0) return null;
    const calls = [...pending.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c]) => ({ id: c.id, name: c.name, arguments: c.arguments }))
      .filter((c) => c.name.length > 0);
    pending.clear();
    return calls.length > 0 ? { type: "tool_calls", calls } : null;
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) {
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          const ev = flush();
          if (ev) yield ev;
          return;
        }
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta;
          if (typeof delta?.content === "string" && delta.content.length > 0) {
            yield { type: "delta", text: delta.content };
          }
          for (const tc of delta?.tool_calls ?? []) {
            const idx = typeof tc.index === "number" ? tc.index : 0;
            const slot = pending.get(idx) ?? { id: "", name: "", arguments: "" };
            if (typeof tc.id === "string" && tc.id) slot.id = tc.id;
            if (typeof tc.function?.name === "string" && tc.function.name) slot.name = tc.function.name;
            if (typeof tc.function?.arguments === "string") slot.arguments += tc.function.arguments;
            pending.set(idx, slot);
          }
        } catch {
          // ignore malformed keep-alive/partial lines
        }
      }
    }
  }
  const ev = flush();
  if (ev) yield ev;
}
