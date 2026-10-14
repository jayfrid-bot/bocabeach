// The install-token checks.
//
//  - `requireInstallToken`: strict, for the read-style routes that always
//    needed a token (/api/live-activity/register and /end, /api/hazards,
//    /api/history). A row with no token on file gets `token-required`; the
//    phone claims one (lib/plus/installToken.ts) and retries.
//  - `authorizeMinting` and `guardForWrite`, below: for every route that
//    CHANGES a device row (/api/devices, /api/presence, trial, unlock, push
//    register/unregister). The guard rides inside the write itself.
//
// `token_used_at` (migrations/0008_device_tokens.sql) is kept as cheap
// diagnostics — nothing in this file or elsewhere gates on it.
//
// THREAT MODEL:
//  - deviceId is a 128-bit random value, minted client-side. It is NOT a
//    secret: the app shows it as the "Support ID", it travels in every request,
//    and anyone who sees it can replay it. The install token is what
//    authenticates.
//  - The PHONE makes the install token (32 random bytes), saves it, and then
//    sends it; the server stores only its sha256 hash and binds it with one
//    idempotent conditional statement (`DeviceStore.claimInstallToken`). First
//    token to reach a row wins; presenting the same token again always works,
//    so a lost response, a killed app or a retry cannot lock the phone out.
//    The server NEVER makes a token. A request with no token (an older
//    WebView, while INSTALL_TOKEN_ENFORCE is off) goes through and leaves the
//    row unclaimed.
//  - A row that already has a push token but no install token yet can be
//    claimed only by a request that also presents that push token. A row with
//    neither is first-claim: whoever claims it first owns it. That is the
//    accepted residual risk for rows that were never active; it is low value
//    (such a row has no push target to redirect).
//  - There is deliberately no server-side recovery for a lost token. A phone
//    that loses its saved token but keeps its device id is refused on every
//    route that changes its row; the app says so in plain words. The device id
//    and the token live in the same local storage, so losing one normally
//    loses both and the app starts over as a new device; a reinstall gets a new
//    deviceId, and RevenueCat restore-purchases (keyed off the store account,
//    not deviceId) carries the Plus entitlement back.
//  - The comparison inside a write is sha256(token) = stored sha256 in SQL.
//    Hashes of attacker-chosen input leak nothing useful through timing; the
//    JS-side comparisons (`installTokenMatches`, `guardAllows`) are constant
//    time anyway.
//  - Later: App Attest is the planned upgrade for device-bound auth (ties
//    the token to Apple's hardware attestation instead of "whoever got there
//    first"), tracked in docs/BUILD_PLAN.md.

import { installTokenMatches, type DeviceStore } from "@/lib/db/store";
import {
  guardFromHeader,
  hashOfToken,
  installTokenEnforced,
  NO_GUARD,
  type InstallGuard,
} from "@/lib/db/installGuard";


export type InstallTokenCheck = "ok" | "token-required" | "no-token";

/**
 * `token-required`: this device has never had a token minted at all (no hash
 * on file) — the client bootstraps one (lib/plus/client.ts's
 * `ensureInstallToken`) and retries.
 * `no-token`: a hash exists but the caller sent no header, or the wrong
 * token — the client's one bootstrap-and-retry (round-2 #1b) covers the
 * common "lost it locally" case; anything past that is quietly given up on.
 * `ok`: the header matched. As a side effect (fire-and-forget by design —
 * never blocks or fails the caller's real request), this marks the token
 * used via one cheap `UPDATE ... WHERE token_used_at IS NULL`, a no-op after
 * the very first successful call for a given token.
 */
export async function requireInstallToken(
  store: DeviceStore,
  deviceId: string,
  headerToken: string | null,
  now: number,
): Promise<InstallTokenCheck> {
  const tokenHash = await store.getInstallTokenHash(deviceId);
  if (!tokenHash) return "token-required";
  return (await verifyAndMark(store, deviceId, tokenHash, headerToken, now)) ? "ok" : "no-token";
}

/** Constant-time match, then the fire-and-forget "mark used" bookkeeping. */
async function verifyAndMark(
  store: DeviceStore,
  deviceId: string,
  tokenHash: string,
  headerToken: string | null,
  now: number,
): Promise<boolean> {
  if (!headerToken || !installTokenMatches(tokenHash, headerToken)) return false;
  // Never let a bookkeeping failure here fail the real request — the token
  // still checked out, so the caller is authenticated regardless of whether
  // this write lands.
  try {
    await store.markInstallTokenUsed(deviceId, now);
  } catch (e) {
    console.error("installTokenAuth: markInstallTokenUsed failed", e);
  }
  return true;
}

// --- Gate for routes that CHANGE a device row (push-token-auth) --------------
//
// Every route that writes a device row or anything keyed by a device id —
// push register/unregister, device prefs/home beach, presence, trial, unlock —
// is guarded by the install token, because the device id is not a secret (it is
// the "Support ID"). Two kinds of route:
//
//  MINTING routes (`/api/devices`, `/api/push/register-native`) can bind a
//  token to a device. The CLIENT makes the token (32 random bytes), saves it on
//  the phone, and only then sends it; `authorizeMinting` binds its hash with
//  one idempotent conditional statement (`store.claimInstallToken`). Because a
//  retry with the same token succeeds again, a lost response can never lock
//  the phone out. The rules for which rows may be claimed are on
//  `DeviceStore.claimInstallToken`.
//
//  Every other mutating route (trial, unlock, presence, unregister) never
//  binds anything. It builds an `InstallGuard` from the header and passes it to
//  the store write, which applies it inside the same statement. There is no
//  separate read ("is this caller allowed?") before the write.
//
// INSTALL_TOKEN_ENFORCE (default off) stages the rollout. Off: a request with
// no token still goes through as it did before this gate, but a token that IS
// sent is checked, and claims still happen. On: no valid token, no write.

/** True when the caller says it is a client that knows about install tokens
 *  (`x-client-cap: install-token-v1`, sent by every current app build). Lets the
 *  missing-token log tell an older WebView apart from a current one whose
 *  storage refused a token. */
export function clientHasCap(req: Request): boolean {
  return req.headers.get("x-client-cap") === "install-token-v1";
}

/** Count a request that arrived with no install token, so the owner can see
 *  when it is safe to turn INSTALL_TOKEN_ENFORCE on. One line: the route name,
 *  whether the client sent the capability header, and nothing else — no device
 *  id, no token, no address. */
export function noteMissingToken(route: string, clientCap: boolean): void {
  console.log(
    JSON.stringify({ event: "install_token_missing", route, enforce: installTokenEnforced(), clientCap }),
  );
}

export type MintAuth = { ok: true; guard: InstallGuard; bound: boolean } | { ok: false };

/**
 * For a route that can bind a token. `proofPushToken` is the push token the
 * caller presents as proof it is the real phone (needed to claim an existing
 * row that has a push token but no install token yet).
 *
 *  - Token sent: it is claimed (idempotently) or the request is refused, with
 *    enforcement on OR off. A token that cannot be bound is never waved through.
 *  - No token sent: refused when enforcing. Otherwise it goes through with NO
 *    guard and the row stays unclaimed: only a token the phone made and saved
 *    ever binds, never one the server made.
 *
 * `bound` is true only when this request's token is now bound to the row; the
 * route says so in its response (`installTokenBound`) and the phone records
 * "claimed" from that signal alone.
 */
export async function authorizeMinting(
  store: DeviceStore,
  deviceId: string,
  headerToken: string | null,
  proofPushToken: string | null,
  route: string,
  clientCap: boolean,
  now: number,
): Promise<MintAuth> {
  if (headerToken) {
    const hash = hashOfToken(headerToken);
    if (await store.claimInstallToken(deviceId, hash, proofPushToken, now)) {
      return { ok: true, guard: { hash, enforce: installTokenEnforced() }, bound: true };
    }
    return { ok: false };
  }
  noteMissingToken(route, clientCap);
  if (installTokenEnforced()) return { ok: false };
  return { ok: true, guard: NO_GUARD, bound: false };
}

/** For a route that never binds a token: the guard its write must carry. */
export function guardForWrite(req: Request, route: string): InstallGuard {
  const header = req.headers.get("x-install-token");
  if (!header) noteMissingToken(route, clientHasCap(req));
  return guardFromHeader(header);
}
