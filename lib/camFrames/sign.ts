// Signed, short-lived links for archived webcam frames (docs/CAM_ARCHIVE_PLAN.md
// R9). A link is `?k=<r2_key>&exp=<unix seconds>&sig=<signature>`, where
//
//   sig = base64url( HMAC-SHA256( CAM_FRAME_URL_KEY, `${k}|${exp}` ) )
//
// Signing happens only inside the entitled day route. No device id travels in
// the URL. Links live 15 minutes. verify() also refuses an `exp` more than 20
// minutes ahead, so a leaked or forged long-lived signature cannot be minted
// by anyone holding an old key slice, and it compares in constant time.

import { secretEqual } from "@/lib/db/api";
import { isSignableKey } from "@/lib/camFrames/keys";

export const DEFAULT_TTL_SEC = 900;
/** verify() refuses an expiry further out than this. */
export const MAX_EXP_AHEAD_SEC = 1200;

/** A base64url SHA-256 HMAC is exactly 43 characters (no padding). */
const SIG_RE = /^[A-Za-z0-9_-]{43}$/;
/** Digits only, up to 12 (far past year 5000), no sign, no decimal. */
const EXP_RE = /^[0-9]{1,12}$/;

function urlKey(explicit?: string): string | null {
  const key = explicit ?? process.env.CAM_FRAME_URL_KEY;
  return typeof key === "string" && key.length > 0 ? key : null;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return b64url(new Uint8Array(mac));
}

export interface SignedFrame {
  /** Unix seconds. */
  exp: number;
  sig: string;
}

/**
 * Sign an R2 key. Throws when `k` is not an archive key or the signing key is
 * not configured (the day route turns that into a 503: it must not hand out
 * unsigned links).
 */
export async function sign(
  k: string,
  ttlSec: number = DEFAULT_TTL_SEC,
  opts?: { nowSec?: number; key?: string },
): Promise<SignedFrame> {
  if (!isSignableKey(k)) throw new Error("cam frame: malformed key");
  const key = urlKey(opts?.key);
  if (!key) throw new Error("cam frame: CAM_FRAME_URL_KEY is not set");
  if (!Number.isInteger(ttlSec) || ttlSec < 1 || ttlSec > MAX_EXP_AHEAD_SEC) {
    throw new Error("cam frame: bad ttl");
  }
  const nowSec = opts?.nowSec ?? Math.floor(Date.now() / 1000);
  const exp = nowSec + ttlSec;
  return { exp, sig: await hmac(key, `${k}|${exp}`) };
}

/**
 * True only for a well-formed key, an integer `exp` in (now, now + 20 min], and
 * a signature that matches. `exp` and `sig` arrive as query strings; a number
 * is accepted for exp so callers and tests can pass either.
 */
export async function verify(
  k: unknown,
  exp: unknown,
  sig: unknown,
  nowSec: number = Math.floor(Date.now() / 1000),
  opts?: { key?: string },
): Promise<boolean> {
  if (!isSignableKey(k)) return false;
  if (typeof sig !== "string" || !SIG_RE.test(sig)) return false;
  let expN: number;
  if (typeof exp === "number") {
    if (!Number.isSafeInteger(exp) || exp < 0) return false;
    expN = exp;
  } else if (typeof exp === "string" && EXP_RE.test(exp)) {
    expN = Number(exp);
  } else {
    return false;
  }
  if (expN <= nowSec) return false; // expired
  if (expN > nowSec + MAX_EXP_AHEAD_SEC) return false; // too far ahead
  const key = urlKey(opts?.key);
  if (!key) return false; // no key configured: nothing can verify
  const expected = await hmac(key, `${k}|${expN}`);
  return secretEqual(sig, expected);
}
