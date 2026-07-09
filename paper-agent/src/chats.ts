import type { Env, ChatRecord, StoredChatMessage } from "./types";

const DEFAULT_TITLE = "新對話";
const TITLE_MAX = 30;

/** KV key for one chat record. */
export function chatKey(sessionId: string, chatId: string): string {
  return `s:${sessionId}:chat:${chatId}`;
}

/** Prefix under which all of a session's chats live. */
export function chatPrefix(sessionId: string): string {
  return `s:${sessionId}:chat:`;
}

async function save(env: Env, sessionId: string, chatId: string, rec: ChatRecord): Promise<void> {
  await env.PAPERS_KV.put(chatKey(sessionId, chatId), JSON.stringify(rec), {
    metadata: { title: rec.title, updatedAt: rec.updatedAt },
  });
}

/** Create an empty chat record. */
export async function newChat(env: Env, sessionId: string, chatId: string): Promise<ChatRecord> {
  const now = Date.now();
  const rec: ChatRecord = { title: DEFAULT_TITLE, createdAt: now, updatedAt: now, messages: [] };
  await save(env, sessionId, chatId, rec);
  return rec;
}

/** Load a chat record, or null if it does not exist. */
export async function loadChat(
  env: Env,
  sessionId: string,
  chatId: string,
): Promise<ChatRecord | null> {
  const raw = await env.PAPERS_KV.get(chatKey(sessionId, chatId));
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as ChatRecord;
  } catch {
    return null;
  }
}

/**
 * Append messages to a chat (creating it on the fly if needed). The first
 * user message ever appended becomes the chat title (truncated).
 */
export async function appendMessages(
  env: Env,
  sessionId: string,
  chatId: string,
  messages: StoredChatMessage[],
): Promise<ChatRecord> {
  const now = Date.now();
  const rec: ChatRecord =
    (await loadChat(env, sessionId, chatId)) ?? {
      title: DEFAULT_TITLE,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };

  const isFirstUserMessage = !rec.messages.some((m) => m.role === "user");
  rec.messages.push(...messages);
  if (isFirstUserMessage) {
    const firstUser = messages.find((m) => m.role === "user");
    if (firstUser) rec.title = firstUser.content.slice(0, TITLE_MAX);
  }
  // strictly increasing so list ordering is stable even within one millisecond
  rec.updatedAt = now > rec.updatedAt ? now : rec.updatedAt + 1;

  await save(env, sessionId, chatId, rec);
  return rec;
}

/** List a session's chats (id/title/updatedAt), most recently updated first. */
export async function listChats(
  env: Env,
  sessionId: string,
): Promise<Array<{ id: string; title: string; updatedAt: number }>> {
  const prefix = chatPrefix(sessionId);
  const list = await env.PAPERS_KV.list({ prefix });
  const chats = list.keys.map((k) => {
    const md = (k.metadata ?? {}) as { title?: string; updatedAt?: number };
    return {
      id: k.name.slice(prefix.length),
      title: md.title ?? DEFAULT_TITLE,
      updatedAt: md.updatedAt ?? 0,
    };
  });
  return chats.sort((a, b) => b.updatedAt - a.updatedAt);
}
