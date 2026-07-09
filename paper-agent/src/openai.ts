import type { Env, ChatMessage } from "./types";

const EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const CHAT_URL = "https://api.openai.com/v1/chat/completions";

async function postJson(url: string, apiKey: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
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
  const json = await postJson(EMBEDDINGS_URL, env.OPENAI_API_KEY, {
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
  const json = await postJson(CHAT_URL, env.OPENAI_API_KEY, chatBody(env, messages));
  return json.choices?.[0]?.message?.content ?? "";
}

/**
 * Run a streaming chat completion, yielding assistant text deltas as they
 * arrive. Parses OpenAI's SSE format (`data: {...}` lines, `data: [DONE]`).
 */
export async function* chatStream(env: Env, messages: ChatMessage[]): AsyncGenerator<string> {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
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
