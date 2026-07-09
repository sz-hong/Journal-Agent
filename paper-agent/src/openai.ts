import type { Env, ChatMessage } from "./types";

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

function chatBody(env: Env, messages: ChatMessage[]): Record<string, unknown> {
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
