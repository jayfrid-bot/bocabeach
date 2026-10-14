// Who is the owner? Whoever holds an owner session token (lib/quality/ownerSessions.ts).
//
// ENROLLMENT. The OWNER_ENROLL_CODE secret is the one-time credential. The owner opens
// /admin/review#enroll=<code> once on the phone; the page POSTs the code in a request
// BODY (never in a URL the server sees, never logged) to /api/quality/owner/enroll. If it
// matches (constant time, after hashing both sides), the server makes a session and returns
// its token once. Enrollment is rate limited (5 tries an hour per address, 20 an hour in all).
// Changing the secret stops the old code from enrolling anyone new; it does NOT end sessions
// already made. To end them: UPDATE owner_sessions SET revoked = 1 (docs/QUALITY_PLAN.md).
//
// EVERY OTHER OWNER ROUTE needs `Authorization: Bearer <token>`. A device id proves nothing
// here and is never a credential; nothing about the general Plus device store is consulted.
//
// The pages /admin/review and /admin/report are public shells with no data in them. Every
// number and picture arrives through routes that pass requireOwner. Owner responses, and the
// admin pages, forbid framing (lib/quality/ownerHeaders.ts, next.config.mjs).

import { bearerToken, readBodyCapped, sha256Hex } from "@/lib/camFrames/ingest";
import { secretEqual } from "@/lib/db/api";
import { getD1, type D1Like } from "@/lib/db/d1Store";
import { checkRateLimit, clientIp } from "@/lib/plus/rateLimit";
import { ownerFail } from "@/lib/quality/ownerHeaders";
import { createSession, findSession, newOwnerToken, touchSession, type OwnerSession } from "@/lib/quality/ownerSessions";

const MAX_ATTEMPTS_IP = 240;
const WINDOW_MS = 60 * 60 * 1000;
const ENROLL_PER_IP = 5;
const ENROLL_ALL = 20;
/** Owner request bodies are tiny. */
export const MAX_OWNER_BODY_BYTES = 8 * 1024;

/** True when OWNER_ENROLL_CODE is set to something usable. */
export function enrollmentConfigured(code: string | undefined): boolean {
  return typeof code === "string" && code.length >= 16;
}

/** Constant-time check of a presented code against the secret: both sides hashed first, so length does not leak. */
export async function enrollCodeMatches(presented: unknown, secret: string | undefined = process.env.OWNER_ENROLL_CODE): Promise<boolean> {
  if (typeof presented !== "string" || !enrollmentConfigured(secret)) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([sha256Hex(enc.encode(presented)), sha256Hex(enc.encode(secret as string))]);
  return secretEqual(a, b);
}

export type JsonBody = { ok: true; body: Record<string, unknown> } | { ok: false; status: number; error: string };

/** Read a small JSON object body WITHOUT buffering past the cap (the stream is cancelled at 8 KB). An empty body is {}. */
export async function readOwnerBody(req: Request): Promise<JsonBody> {
  const read = await readBodyCapped(req, MAX_OWNER_BODY_BYTES);
  if (!read.ok) {
    if (read.reason === "empty") return { ok: true, body: {} };
    return read.reason === "too-large" ? { ok: false, status: 413, error: "too-large" } : { ok: false, status: 400, error: "bad-request" };
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(read.bytes)) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    /* fall through */
  }
  return { ok: false, status: 400, error: "bad-request" };
}

/** Enroll a phone. Returns the one-time token, or a Response to send back. */
export async function enrollOwner(req: Request, db: D1Like, body: Record<string, unknown>): Promise<Response | { token: string }> {
  if (!enrollmentConfigured(process.env.OWNER_ENROLL_CODE)) return ownerFail("enrollment-closed", 503);
  const ip = clientIp(req) ?? "unknown";
  const [byIp, all] = [
    await checkRateLimit(`quality-enroll:ip:${ip}`, ENROLL_PER_IP, WINDOW_MS),
    await checkRateLimit("quality-enroll:all", ENROLL_ALL, WINDOW_MS),
  ];
  const limited = byIp.limited ? byIp : all.limited ? all : null;
  if (limited) return ownerFail("too-many-attempts", 429, { "Retry-After": String(limited.retryAfterSec) });
  if (!(await enrollCodeMatches(body.code))) return ownerFail("bad-code", 403);
  const deviceId = typeof body.deviceId === "string" ? body.deviceId.slice(0, 128) : "unknown";
  const token = newOwnerToken();
  await createSession(db, { deviceId, token, nowMs: Date.now() });
  return { token };
}

/** Check the Bearer owner token. Returns the live session, or a Response to send back. */
export async function requireOwner(req: Request, db: D1Like): Promise<Response | OwnerSession> {
  const token = bearerToken(req.headers.get("authorization"));
  if (!token) return ownerFail("unauthorized", 401);

  const limited = await checkRateLimit(`quality-owner:ip:${clientIp(req) ?? "unknown"}`, MAX_ATTEMPTS_IP, WINDOW_MS);
  if (limited.limited) return ownerFail("too-many-attempts", 429, { "Retry-After": String(limited.retryAfterSec) });

  try {
    const session = await findSession(db, token);
    if (!session) return ownerFail("unauthorized", 401);
    await touchSession(db, session, Date.now());
    return session;
  } catch (e) {
    console.error("quality owner: session check failed", e);
    return ownerFail("store-unavailable", 500);
  }
}

/** The D1 binding for an owner route, or a 503 Response. */
export async function ownerDb(): Promise<Response | D1Like> {
  const db = await getD1();
  return db ?? ownerFail("store-unavailable", 503);
}
