// POST /api/devices/unlock — redeem a Plus code. Body { deviceId, code }.
//
// One or more shared codes grant a year on the dedicated `codeUntil` grant
// (#4) — independent of any store purchase or trial, so redeeming a code can
// never shorten (or be shortened by) either of those. It is how friends,
// testers and the owner get Plus before billing exists. A wrong code — or no
// code configured — answers 403 { ok: false, error: "bad-code" }, so the
// endpoint never reveals whether the feature is switched on.
//
// PLUS_UNLOCK_CODE is the original single-code secret; PLUS_UNLOCK_CODES is an
// optional comma-separated list of additional valid codes, so a code that
// leaks can be revoked on its own (drop it from the list) without rotating
// the one everyone else still uses. Every candidate is still compared with a
// constant-time equal.
//
// Rate limited: a code is a short shared secret, so a guesser could otherwise
// brute-force it. Each request is checked against two KV counters — one keyed
// by IP, one by deviceId — capped at 5 attempts per hour; past that it answers
// 429 with Retry-After instead of running the compare at all.

import { badRequest, fail, isDeviceId, okDevice, readBody, secretEqual } from "@/lib/db/api";
import { getStore } from "@/lib/db/store";
import { UNLOCK_DAYS } from "@/lib/db/plus";
import { isNativeRequest } from "@/lib/nativeRequest";
import { checkRateLimit, clientIp } from "@/lib/plus/rateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60 * 60 * 1000;

function unlockCodes(): string[] {
  const single = process.env.PLUS_UNLOCK_CODE ?? "";
  const list = (process.env.PLUS_UNLOCK_CODES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [single, ...list].filter(Boolean);
}

function rateLimited(retryAfterSec: number): Response {
  return Response.json(
    { ok: false, error: "too-many-attempts" },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
  );
}

export async function POST(req: Request): Promise<Response> {
  // App only, like the trial: Plus is delivered inside the phone app.
  if (!isNativeRequest(req)) return fail("app-only", 403);
  const body = await readBody(req);
  if (!body || !isDeviceId(body.deviceId)) return badRequest();
  if (typeof body.code !== "string" || body.code.length > 256) return badRequest();

  const deviceId = body.deviceId;
  const ip = clientIp(req) ?? "unknown";
  const byIp = await checkRateLimit(`unlock:ip:${ip}`, MAX_ATTEMPTS, WINDOW_MS);
  if (byIp.limited) return rateLimited(byIp.retryAfterSec);
  const byDevice = await checkRateLimit(`unlock:device:${deviceId}`, MAX_ATTEMPTS, WINDOW_MS);
  if (byDevice.limited) return rateLimited(byDevice.retryAfterSec);

  const candidates = unlockCodes();
  const matched = candidates.length > 0 && candidates.some((c) => secretEqual(body.code as string, c));
  if (!matched) return fail("bad-code", 403);

  try {
    const store = await getStore();
    const until = Date.now() + UNLOCK_DAYS * 24 * 3600 * 1000;
    return okDevice(await store.upsertDevice(deviceId, { codeUntil: until }));
  } catch (e) {
    console.error("devices/unlock: failed", e);
    return fail("store-unavailable", 500);
  }
}
