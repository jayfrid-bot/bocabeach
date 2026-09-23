// The install-token check shared by every route that requires one:
// /api/live-activity/register, /end, and /api/hazards. Was three copies of
// the same three lines; pulled into one place so the "mark it used" side
// effect (round-2 #2 followup) can't drift between them.
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
//    (reinstall, cleared storage) simply reads back `no-token` from
//    `requireInstallToken` below and the client degrades to "not available"
//    for Live Activity / Where-you-stand — Plus alerts, presence, and
//    everything else are not gated by this token at all. A genuine
//    reinstall gets a NEW deviceId, and RevenueCat restore-purchases (keyed
//    off the store account, not deviceId) carries the Plus entitlement back
//    without needing the old token at all.
//  - Later: App Attest is the planned upgrade for device-bound auth (ties
//    the token to Apple's hardware attestation instead of "whoever got the
//    first response"), tracked in docs/BUILD_PLAN.md.

import { installTokenMatches, type DeviceStore } from "@/lib/db/store";

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
  if (!headerToken || !installTokenMatches(tokenHash, headerToken)) return "no-token";
  // Never let a bookkeeping failure here fail the real request — the token
  // still checked out, so the caller is authenticated regardless of whether
  // this write lands.
  try {
    await store.markInstallTokenUsed(deviceId, now);
  } catch (e) {
    console.error("installTokenAuth: markInstallTokenUsed failed", e);
  }
  return "ok";
}
