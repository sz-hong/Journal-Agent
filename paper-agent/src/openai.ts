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
  const json = await postJson(EMBEDDINGS_URL, env.OPENAI_API_KEY, {
    model: env.OPENAI_EMBED_MODEL,
    input: inputs,
  });
  return (json.data as Array<{ embedding: number[] }>).map((d) => d.embedding);
}

/** Embed a single query string. */
export async function embedQuery(env: Env, text: string): Promise<number[]> {
  const [vec] = await embedTexts(env, [text]);
  return vec;
}

/** Run a chat completion and return the assistant's message content. */
export async function chat(env: Env, messages: ChatMessage[]): Promise<string> {
  const json = await postJson(CHAT_URL, env.OPENAI_API_KEY, {
    model: env.OPENAI_CHAT_MODEL,
    messages,
    temperature: 0.2,
  });
  return json.choices?.[0]?.message?.content ?? "";
}
