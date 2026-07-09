import { describe, it, expect, vi, beforeEach } from "vitest";
import { chatKey, newChat, loadChat, appendMessages, listChats } from "../src/chats";
import type { Env } from "../src/types";

function makeKv() {
  const store = new Map<string, { value: string; metadata?: unknown }>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key)?.value ?? null),
    put: vi.fn(async (key: string, value: string, opts?: { metadata?: unknown }) => {
      store.set(key, { value, metadata: opts?.metadata });
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async ({ prefix = "" }: { prefix?: string } = {}) => ({
      keys: [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([name, v]) => ({ name, metadata: v.metadata })),
      list_complete: true,
    })),
  };
}

let kv: ReturnType<typeof makeKv>;
let env: Env;

beforeEach(() => {
  kv = makeKv();
  env = { PAPERS_KV: kv } as unknown as Env;
});

describe("chatKey", () => {
  it("builds the prefixed KV key", () => {
    expect(chatKey("sid1", "chat1")).toBe("s:sid1:chat:chat1");
  });
});

describe("newChat / loadChat", () => {
  it("creates an empty chat record with a default title and loads it back", async () => {
    const rec = await newChat(env, "sid1", "chat1");
    expect(rec.title).toBe("新對話");
    expect(rec.messages).toEqual([]);

    const loaded = await loadChat(env, "sid1", "chat1");
    expect(loaded).toEqual(rec);
  });

  it("loadChat returns null for a missing chat", async () => {
    expect(await loadChat(env, "sid1", "nope")).toBeNull();
  });
});

describe("appendMessages", () => {
  it("appends user+assistant messages and sets the title from the first user message", async () => {
    await newChat(env, "sid1", "chat1");
    const rec = await appendMessages(env, "sid1", "chat1", [
      { role: "user", content: "什麼是 FaceNet？這是一個很長的問題會被截斷嗎？超過三十個字的部分不該出現在標題裡" },
      { role: "assistant", content: "FaceNet 是…", citations: [{ title: "T", page: 1 }] },
    ]);
    expect(rec.messages).toHaveLength(2);
    expect(rec.title.length).toBeLessThanOrEqual(30);
    expect(rec.title.startsWith("什麼是 FaceNet？")).toBe(true);
    expect(rec.updatedAt).toBeGreaterThanOrEqual(rec.createdAt);

    // KV metadata mirrors title/updatedAt for cheap listing
    const stored = kv.store.get("s:sid1:chat:chat1");
    expect((stored?.metadata as any).title).toBe(rec.title);
  });

  it("does not overwrite the title on later messages", async () => {
    await newChat(env, "sid1", "chat1");
    await appendMessages(env, "sid1", "chat1", [{ role: "user", content: "第一個問題" }]);
    const rec = await appendMessages(env, "sid1", "chat1", [{ role: "user", content: "第二個問題" }]);
    expect(rec.title).toBe("第一個問題");
    expect(rec.messages).toHaveLength(2);
  });

  it("creates the record on the fly if the chat does not exist yet", async () => {
    const rec = await appendMessages(env, "sid1", "ghost", [{ role: "user", content: "hi" }]);
    expect(rec.messages).toHaveLength(1);
  });
});

describe("listChats", () => {
  it("lists chats for one session only, newest-updated first", async () => {
    await newChat(env, "sid1", "c1");
    await newChat(env, "sid1", "c2");
    await newChat(env, "sid2", "other");
    await appendMessages(env, "sid1", "c1", [{ role: "user", content: "newer activity" }]);

    const chats = await listChats(env, "sid1");
    expect(chats.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(chats[0].title).toBe("newer activity");
  });
});
