// Owner sessions (migrations/0019 `owner_sessions`): who the owner is.
//
// A phone enrolls once with the OWNER_ENROLL_CODE secret (lib/quality/owner.ts). The
// server makes a random 32-byte token, returns it ONCE, and keeps only its SHA-256 here.
// Every owner route then needs `Authorization: Bearer <token>`. Nothing about a device id
// proves anything: a session is the token, and the device id is only a label.

import type { D1Like } from "@/lib/db/d1Store";
import { sha256Hex } from "@/lib/camFrames/ingest";

/** An owner token is 32 random bytes as base64url: exactly 43 characters. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** last_seen is refreshed at most this often, to spare a D1 write on every owner call. */
export const TOUCH_EVERY_MS = 10 * 60_000;

export function newOwnerToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function looksLikeOwnerToken(v: unknown): v is string {
  return typeof v === "string" && TOKEN_RE.test(v);
}

export async function hashOwnerToken(token: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(token));
}

export interface OwnerSession {
  id: number;
  device_id: string;
  last_seen: string;
}

export async function createSession(db: D1Like, a: { deviceId: string; token: string; nowMs: number }): Promise<number> {
  const at = new Date(a.nowMs).toISOString();
  const r = await db
    .prepare(
      "INSERT INTO owner_sessions (device_id, token_hash, created_at, last_seen, revoked) VALUES (?1, ?2, ?3, ?3, 0) RETURNING id",
    )
    .bind(a.deviceId, await hashOwnerToken(a.token), at)
    .first<{ id: number }>();
  return Number(r?.id ?? 0);
}

/** The live (not revoked) session for a token, or null. */
export async function findSession(db: D1Like, token: string): Promise<OwnerSession | null> {
  if (!looksLikeOwnerToken(token)) return null;
  return db
    .prepare("SELECT id, device_id, last_seen FROM owner_sessions WHERE token_hash = ?1 AND revoked = 0")
    .bind(await hashOwnerToken(token))
    .first<OwnerSession>();
}

export async function touchSession(db: D1Like, s: OwnerSession, nowMs: number): Promise<void> {
  if (nowMs - Date.parse(s.last_seen) < TOUCH_EVERY_MS) return;
  await db.prepare("UPDATE owner_sessions SET last_seen = ?2 WHERE id = ?1").bind(s.id, new Date(nowMs).toISOString()).run();
}

export async function setSessionPushToken(db: D1Like, id: number, pushToken: string, nowMs: number): Promise<void> {
  await db
    .prepare("UPDATE owner_sessions SET push_token = ?2, push_updated_at = ?3 WHERE id = ?1 AND revoked = 0")
    .bind(id, pushToken, new Date(nowMs).toISOString())
    .run();
}

export async function clearSessionPushToken(db: D1Like, id: number): Promise<void> {
  await db.prepare("UPDATE owner_sessions SET push_token = NULL WHERE id = ?1").bind(id).run();
}

export interface PushSession {
  id: number;
  push_token: string;
}

/** Live sessions that have a push token, most recently updated first. */
export async function sessionsWithPushToken(db: D1Like, limit: number): Promise<PushSession[]> {
  const r = await db
    .prepare(
      "SELECT id, push_token FROM owner_sessions WHERE revoked = 0 AND push_token IS NOT NULL " +
        "ORDER BY push_updated_at DESC, id DESC LIMIT ?1",
    )
    .bind(limit)
    .all<PushSession>();
  return r.results ?? [];
}
