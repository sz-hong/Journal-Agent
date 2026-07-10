import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  hashPassword,
  verifyPassword,
  issueToken,
  resolveToken,
  revokeToken,
  getUser,
  putUser,
  upsertUserSession,
  removeUserSession,
} from "../src/auth";
import type { Env, UserRecord } from "../src/types";

function makeKv() {
  const store = new Map<string, { value: string; ttl?: number }>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key)?.value ?? null),
    put: vi.fn(async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      store.set(key, { value, ttl: opts?.expirationTtl });
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async () => ({ keys: [], list_complete: true })),
  };
}

let kv: ReturnType<typeof makeKv>;
let env: Env;

beforeEach(() => {
  kv = makeKv();
  env = { PAPERS_KV: kv } as unknown as Env;
});

describe("password hashing (PBKDF2)", () => {
  it("hashes and verifies a password round-trip", async () => {
    const { hash, salt, iterations } = await hashPassword("correct horse battery");
    expect(iterations).toBeGreaterThanOrEqual(100_000);
    expect(salt).not.toBe("");
    expect(hash).not.toContain("correct");
    expect(await verifyPassword("correct horse battery", salt, hash, iterations)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const { hash, salt, iterations } = await hashPassword("right-password");
    expect(await verifyPassword("wrong-password", salt, hash, iterations)).toBe(false);
  });

  it("produces different hashes for the same password (random salt)", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("tokens", () => {
  it("issues a token resolvable to the email, with a TTL", async () => {
    const token = await issueToken(env, "a@b.c");
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(await resolveToken(env, token)).toBe("a@b.c");
    const put = kv.put.mock.calls.find((c: any[]) => String(c[0]).startsWith("tok:")) as any[];
    expect(put[2].expirationTtl).toBeGreaterThan(0);
  });

  it("returns null for unknown or revoked tokens", async () => {
    expect(await resolveToken(env, "nope")).toBeNull();
    const token = await issueToken(env, "a@b.c");
    await revokeToken(env, token);
    expect(await resolveToken(env, token)).toBeNull();
  });
});

describe("user store + session list", () => {
  const baseUser = (): UserRecord => ({
    pwHash: "h",
    salt: "s",
    iterations: 100_000,
    profile: { name: "小明", school: "台大", dept: "資工", role: "研究生" },
    sessions: [],
    createdAt: 1,
  });

  it("puts and gets a user record", async () => {
    await putUser(env, "a@b.c", baseUser());
    const u = await getUser(env, "a@b.c");
    expect(u?.profile.name).toBe("小明");
    expect(await getUser(env, "no@one.tw")).toBeNull();
  });

  it("upserts sessions: dedupes by id, newest lastUsed first, preserves fields on partial patch", async () => {
    await putUser(env, "a@b.c", baseUser());
    await upsertUserSession(env, "a@b.c", { id: "s1", name: "第一個", role: "擁有者" });
    await upsertUserSession(env, "a@b.c", { id: "s2", name: "第二個", role: "成員" });
    // revisit s1 without a name → name preserved, moves to front
    await upsertUserSession(env, "a@b.c", { id: "s1" });

    const u = await getUser(env, "a@b.c");
    expect(u!.sessions.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(u!.sessions[0].name).toBe("第一個");
    expect(u!.sessions[0].role).toBe("擁有者");
  });

  it("removes a session from the list", async () => {
    await putUser(env, "a@b.c", baseUser());
    await upsertUserSession(env, "a@b.c", { id: "s1", name: "x" });
    await removeUserSession(env, "a@b.c", "s1");
    const u = await getUser(env, "a@b.c");
    expect(u!.sessions).toEqual([]);
  });
});
