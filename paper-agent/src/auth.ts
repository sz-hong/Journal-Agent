import type { Env, UserRecord, UserSessionRef } from "./types";

/**
 * Server-side accounts on Workers-native primitives:
 * - passwords: PBKDF2-SHA256 (WebCrypto) with a per-user random salt
 * - sessions: opaque 256-bit bearer tokens stored in KV with a TTL (revocable)
 */

const PBKDF2_ITERATIONS = 100_000;
const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const MAX_USER_SESSIONS = 50;

const userKey = (email: string) => `user:${email}`;
const tokenKey = (token: string) => `tok:${token}`;

function toB64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function deriveHash(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as unknown as BufferSource, iterations },
    keyMaterial,
    256,
  );
  return toB64url(new Uint8Array(bits));
}

/** Hash a password with a fresh random salt. */
export async function hashPassword(
  password: string,
): Promise<{ hash: string; salt: string; iterations: number }> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = toB64url(saltBytes);
  const hash = await deriveHash(password, saltBytes, PBKDF2_ITERATIONS);
  return { hash, salt, iterations: PBKDF2_ITERATIONS };
}

function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Constant-time string comparison (over same-length hashes). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Verify a password against a stored salt + hash. */
export async function verifyPassword(
  password: string,
  salt: string,
  expectedHash: string,
  iterations: number,
): Promise<boolean> {
  const actual = await deriveHash(password, fromB64url(salt), iterations);
  return timingSafeEqual(actual, expectedHash);
}

/** Issue a bearer token for an email (30-day TTL in KV). */
export async function issueToken(env: Env, email: string): Promise<string> {
  const token = toB64url(crypto.getRandomValues(new Uint8Array(32)));
  await env.PAPERS_KV.put(tokenKey(token), email, { expirationTtl: TOKEN_TTL_SECONDS });
  return token;
}

/** Resolve a token to its email, or null when unknown/expired/revoked. */
export async function resolveToken(env: Env, token: string): Promise<string | null> {
  if (!token) return null;
  return env.PAPERS_KV.get(tokenKey(token));
}

/** Revoke a token (logout). */
export async function revokeToken(env: Env, token: string): Promise<void> {
  await env.PAPERS_KV.delete(tokenKey(token));
}

/** Load a user record, or null. */
export async function getUser(env: Env, email: string): Promise<UserRecord | null> {
  const raw = await env.PAPERS_KV.get(userKey(email));
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as UserRecord;
  } catch {
    return null;
  }
}

/** Store a user record. */
export async function putUser(env: Env, email: string, user: UserRecord): Promise<void> {
  await env.PAPERS_KV.put(userKey(email), JSON.stringify(user));
}

/**
 * Upsert one session into the user's list: dedupe by id, patch only the
 * provided fields, bump lastUsed, keep most-recently-used first (capped).
 */
export async function upsertUserSession(
  env: Env,
  email: string,
  patch: { id: string; name?: string; role?: string },
): Promise<UserSessionRef[] | null> {
  const user = await getUser(env, email);
  if (!user) return null;
  const old = user.sessions.find((s) => s.id === patch.id);
  const next: UserSessionRef = {
    id: patch.id,
    name: patch.name ?? old?.name ?? "未命名 Session",
    role: patch.role ?? old?.role ?? "成員",
    lastUsed: Date.now(),
  };
  user.sessions = [next, ...user.sessions.filter((s) => s.id !== patch.id)].slice(
    0,
    MAX_USER_SESSIONS,
  );
  await putUser(env, email, user);
  return user.sessions;
}

/** Remove a session from the user's list (does not delete session data). */
export async function removeUserSession(
  env: Env,
  email: string,
  sessionId: string,
): Promise<UserSessionRef[] | null> {
  const user = await getUser(env, email);
  if (!user) return null;
  user.sessions = user.sessions.filter((s) => s.id !== sessionId);
  await putUser(env, email, user);
  return user.sessions;
}
