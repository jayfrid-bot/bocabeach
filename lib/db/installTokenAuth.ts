// The install-token check shared by every route that uses one:
// /api/live-activity/register, /end, /api/hazards and /api/history (via
// `requireInstallToken`), and every route that changes a device row —
// /api/devices, /api/presence, trial, unlock, push register/unregister (via
// `checkInstallToken` / `claimInstallToken`, below). One place, so the "mark it
// used" side effect (round-2 #2 followup) can't drift between them.
//
// `token_used_at` (migrations/0008_device_tokens.sql) is kept as cheap
// diagnostics — nothing in this file or elsewhere gates on it.
//
// THREAT MODEL:
//  - deviceId is a 128-bit random value, minted client-side, never exposed
//    publicly (not logged to a third party, not shown in any UI) — but it is
//    NOT a secret in the cryptographic sense: it travels in every request
//    body/URL, so anyone who observed one (a shared screen, a proxy log)
//    could replay it. The install token is what actually authenticates.
//  - The install token is minted exactly once, by the first POST
//    /api/devices to see this deviceId with no `token_hash` on file
//    (`setInstallTokenHash`'s exactly-once guard) — first minter wins, and
//    it is returned to the caller exactly once, never re-readable server-
//    side (only its hash is stored). It binds every later
//    register/end/hazards call for that deviceId to whoever received that
//    one response.
//  - There is deliberately no server-side recovery path for a lost token.
//    A device that had a token minted, used it, then lost it locally
//    (cleared storage) is refused on every route that changes its row, push
//    registration included, and the client says so in plain words. The
//    device id lives in the same local storage as the token, so losing one
//    normally loses both and the app starts over as a NEW device; a
//    reinstall gets a new deviceId, and RevenueCat restore-purchases (keyed
//    off the store account, not deviceId) carries the Plus entitlement back
//    without needing the old token at all.
//  - A row with no token on file (installed before this gate, or never
//    called POST /api/devices) is not refused: the minting routes bind a
//    token on its next call and the others let it through unchanged. Such a
//    row stays open to whoever claims it first until its phone opens the app.
//  - Later: App Attest is the planned upgrade for device-bound auth (ties
//    the token to Apple's hardware attestation instead of "whoever got the
//    first response"), tracked in docs/BUILD_PLAN.md.

import { hashInstallToken, installTokenMatches, mintInstallToken, type DeviceStore } from "@/lib/db/store";

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
// push register/unregister, device prefs/home beach, presence, trial, unlock
// — goes through `checkInstallToken`, because the device id is not a secret
// (it is the "Support ID") and, before this gate, knowing it was enough to
// redirect or silence someone else's alerts.
//
//  - "ok":        the row has a token on file and the header matched.
//  - "denied":    the row has a token on file and the header is missing or
//                 wrong. The route answers 401 `no-token` and writes nothing.
//  - "unclaimed": the row has NO token on file (a device that predates this
//                 gate, or one that never called POST /api/devices). Routes
//                 that can mint (`/api/devices`, `/api/push/register-native`)
//                 call `claimInstallToken` to bind one; the rest let the
//                 request through exactly as before. This is the migration
//                 path for installs that were never issued a token; it closes
//                 itself as each device claims one.
export type DeviceMutationAuth = "ok" | "denied" | "unclaimed";

export async function checkInstallToken(
  store: DeviceStore,
  deviceId: string,
  headerToken: string | null,
  now: number,
): Promise<DeviceMutationAuth> {
  const tokenHash = await store.getInstallTokenHash(deviceId);
  if (!tokenHash) return "unclaimed";
  return (await verifyAndMark(store, deviceId, tokenHash, headerToken, now)) ? "ok" : "denied";
}

/**
 * Atomically bind a fresh install token to a token-less device row and return
 * the raw token (the caller must hand it to the client in the same response;
 * only its hash is stored). Creates the row first when it does not exist yet.
 * Returns null when another request claimed the row first — the single
 * `UPDATE ... WHERE token_hash IS NULL` in `setInstallTokenHash` decides, so
 * of any number of concurrent claimers exactly one wins. The loser must treat
 * the row as claimed by someone else (re-run `checkInstallToken`, which will
 * now say "denied" unless it holds the winner's token).
 */
export async function claimInstallToken(
  store: DeviceStore,
  deviceId: string,
  now: number,
): Promise<string | null> {
  if (!(await store.getDevice(deviceId))) await store.upsertDevice(deviceId, {});
  const token = mintInstallToken();
  const won = await store.setInstallTokenHash(deviceId, hashInstallToken(token), now);
  return won ? token : null;
}
