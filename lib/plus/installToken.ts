// The phone's install token: make it, keep it, and have the server bind it
// (push-token-auth).
//
// The device id is not a secret (the app shows it as the "Support ID"), so the
// install token is what proves a request comes from the phone that owns a
// device row. The PHONE makes it: 32 random bytes from the system's secure
// random source, saved to local storage BEFORE it is sent anywhere. The server
// only ever stores its hash, and binding a hash is idempotent (sending the same
// token again succeeds again). So:
//   - a lost response, a killed app or a retry can never lock the phone out;
//   - if storage will not keep the token, no claim is sent at all;
//   - a 401 never deletes the saved token (the server cannot issue another, and
//     the right one may simply not have reached the row yet).
//
// One claim runs at a time (single flight). Every write the app makes waits for
// it (lib/plus/api.ts), so a write can never race the claim and lose.

import { getDeviceId } from "@/lib/deviceId";
import { nativePlatform } from "@/lib/push/native";
import * as store from "@/lib/plus/storage";
import { clientCapHeaders } from "@/lib/plus/clientCap";
import type { DeviceRecord } from "@/lib/db/types";

/** 32 random bytes, base64url. Null when the platform has no secure random source. */
export function generateInstallToken(): string | null {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || typeof c.getRandomValues !== "function") return null;
  const bytes = new Uint8Array(32);
  c.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** This phone's token: the saved one, or a fresh one saved first. Null when
 *  storage will not keep it (the caller must then send no claim). */
export function localInstallToken(): string | null {
  const have = store.readInstallToken();
  if (have) return have;
  const made = generateInstallToken();
  if (!made) return null;
  return store.writeInstallToken(made) ? made : null;
}

export interface ClaimOutcome {
  /** The token the server holds for this phone; null when it is not usable now. */
  token: string | null;
  device: DeviceRecord | null;
}

let inFlight: Promise<ClaimOutcome> | null = null;
/** The server said another token owns this row; do not keep asking this session. */
let deniedThisSession = false;
let forcedThisSession = false;

/** Test-only: clear the per-session claim state between tests. */
export function resetClaimState(): void {
  inFlight = null;
  deniedThisSession = false;
  forcedThisSession = false;
}

function baseBody(): { platform: "ios" | "android" | "web"; tz?: string } {
  let tz: string | undefined;
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    tz = undefined;
  }
  return { platform: nativePlatform(), ...(tz ? { tz } : {}) };
}

/**
 * Make sure the server holds this phone's token. Cheap when it already
 * confirmed (a saved flag, no network). `force` asks once more this session
 * after a refusal (for a 401 from a token-gated read), without deleting
 * anything. Never throws.
 */
export function claimInstallToken(opts?: { forceRefresh?: boolean }): Promise<ClaimOutcome> {
  const force = opts?.forceRefresh === true;
  const token = localInstallToken();
  if (!token) return Promise.resolve({ token: null, device: null });
  // The saved "claimed" flag skips the round trip, except when the caller is
  // asking again BECAUSE a token-gated route just refused it (`forceRefresh`):
  // then the flag is not to be trusted and the claim runs again.
  if (!force && store.readInstallClaimed()) return Promise.resolve({ token, device: null });
  if (inFlight) return inFlight;
  if (deniedThisSession) {
    if (!force || forcedThisSession) return Promise.resolve({ token: null, device: null });
    forcedThisSession = true;
  }
  const id = getDeviceId();
  if (!id) return Promise.resolve({ token: null, device: null });

  const run = (async (): Promise<ClaimOutcome> => {
    try {
      const proof = store.readStoredPushToken();
      const res = await fetch("/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-install-token": token, ...clientCapHeaders() },
        body: JSON.stringify({ deviceId: id, ...baseBody(), ...(proof ? { pushProof: proof } : {}) }),
      });
      if (res.status === 401) {
        deniedThisSession = true;
        store.writeInstallClaimed(false);
        return { token: null, device: null };
      }
      const body = (await res.json().catch(() => null)) as
        | { ok?: unknown; device?: unknown; installTokenBound?: unknown }
        | null;
      // "Claimed" is recorded from the server's explicit say-so alone. A 200
      // without it (a request that went through unauthenticated) proves nothing.
      if (res.ok && body?.ok === true && body.installTokenBound === true) {
        store.writeInstallClaimed(true);
        return { token, device: (body.device as DeviceRecord) ?? null };
      }
      return { token: null, device: null }; // a server hiccup: ask again next time
    } catch {
      return { token: null, device: null }; // offline: ask again next time
    }
  })();
  inFlight = run;
  return run.finally(() => {
    inFlight = null;
  });
}

/** Wait for the claim before a write goes out, so the write cannot race it. A
 *  failed claim does not hold the write back; the write then gets its own 401. */
export async function claimBeforeWrite(): Promise<void> {
  try {
    await claimInstallToken();
  } catch {
    /* never blocks a write */
  }
}
