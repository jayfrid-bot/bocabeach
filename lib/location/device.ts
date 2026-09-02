// Client-side device geolocation. Used by BeachFinder ("nearest to you"),
// BeachModeCard's auto-arm, and the FirstRunBanner. On native this talks to
// the Capacitor Geolocation plugin; on web it's a thin wrapper over
// navigator.geolocation. Always resolves — callers never need a try/catch.

import { Geolocation } from "@capacitor/geolocation";
import { isNativePlatform } from "@/lib/push/native";

export interface Fix {
  lat: number;
  lon: number;
  accuracyM: number;
  /** Epoch ms the fix was taken. */
  at: number;
}

export type FixErrorReason = "denied" | "unavailable" | "timeout" | "unsupported";

export interface FixError {
  error: FixErrorReason;
}

/** True inside the Capacitor native app; false in any browser. Re-exports
 *  push's own platform probe so this module never duplicates that (deliberately
 *  hard-won) remote-URL-shell detection logic — see lib/push/native.ts. */
export function isNativeLocation(): boolean {
  return isNativePlatform();
}

/**
 * The native-injected Capacitor bridge (`window.Capacitor`), when present.
 *
 * Same rationale as lib/push/native.ts's nativeBridge(): the web app runs
 * inside the Capacitor shell via a REMOTE URL (capacitor.config.ts's
 * server.url), and in that setup the bundled `@capacitor/core` singleton can
 * initialize in "web" mode before the native bridge attaches. The bridge the
 * WebView actually injects (window.Capacitor) doesn't have that problem, so we
 * prefer it for every call.
 */
function nativeBridge(): { Plugins?: { Geolocation?: typeof Geolocation } } | null {
  if (typeof window === "undefined") return null;
  const cap = (
    window as unknown as { Capacitor?: { Plugins?: { Geolocation?: typeof Geolocation } } }
  ).Capacitor;
  return cap ?? null;
}

// Resolve the Geolocation plugin. Prefer the native-injected bridge proxy;
// fall back to the bundled import for normal bundled-asset builds and browsers.
//
// CRITICAL: this is SYNCHRONOUS, and callers must NOT pass its return value
// through `await`, `Promise.race`, or `Promise.resolve`. Capacitor's plugin
// proxy traps EVERY property access — including `.then` — as a native method
// call, so awaiting the proxy itself (rather than the Promise one of its real
// methods returns) hangs forever chasing a non-existent native "then" method.
// See lib/push/native.ts's getPlugin() for the full incident writeup. Only the
// plugin's actual method calls (getCurrentPosition / checkPermissions /
// requestPermissions), which return genuine Promises, may be awaited.
function getPlugin(): typeof Geolocation {
  return nativeBridge()?.Plugins?.Geolocation ?? Geolocation;
}

/** Best-effort permission read. Never throws; "unknown" when it can't tell. */
export async function checkLocationPermission(): Promise<"granted" | "denied" | "prompt" | "unknown"> {
  if (isNativeLocation()) {
    try {
      const GEO = getPlugin();
      const perm = await GEO.checkPermissions();
      const state = perm.location ?? perm.coarseLocation;
      if (state === "granted") return "granted";
      if (state === "denied") return "denied";
      if (state === "prompt" || state === "prompt-with-rationale") return "prompt";
      return "unknown";
    } catch {
      return "unknown";
    }
  }
  if (typeof navigator === "undefined" || !navigator.permissions?.query) return "unknown";
  try {
    const status = await navigator.permissions.query({ name: "geolocation" as PermissionName });
    const state = status.state;
    return state === "granted" || state === "denied" || state === "prompt" ? state : "unknown";
  } catch {
    return "unknown";
  }
}

function mapWebErrorCode(code: number): FixErrorReason {
  // Matches the standard GeolocationPositionError codes (1/2/3).
  if (code === 1) return "denied";
  if (code === 3) return "timeout";
  return "unavailable";
}

function getWebFix(timeoutMs: number, maxAgeMs: number): Promise<Fix | FixError> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve({ error: "unsupported" });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracyM: pos.coords.accuracy,
          at: pos.timestamp,
        });
      },
      (err) => {
        resolve({ error: mapWebErrorCode(err.code) });
      },
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: maxAgeMs },
    );
  });
}

function mapNativeError(err: unknown): FixError {
  const code = (err as { code?: unknown } | null)?.code;
  // The Capacitor plugin surfaces web-shaped codes on most platforms; be
  // liberal about what we accept (number or numeric string).
  const n = typeof code === "number" ? code : typeof code === "string" ? parseInt(code, 10) : NaN;
  if (n === 1) return { error: "denied" };
  if (n === 3) return { error: "timeout" };
  const message = (err as { message?: string } | null)?.message ?? "";
  if (/denied/i.test(message)) return { error: "denied" };
  if (/timeout/i.test(message)) return { error: "timeout" };
  return { error: "unavailable" };
}

async function getNativeFix(timeoutMs: number, maxAgeMs: number): Promise<Fix | FixError> {
  try {
    const GEO = getPlugin();
    const pos = await GEO.getCurrentPosition({
      enableHighAccuracy: false,
      timeout: timeoutMs,
      maximumAge: maxAgeMs,
    });
    return {
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      accuracyM: pos.coords.accuracy,
      at: pos.timestamp,
    };
  } catch (err) {
    return mapNativeError(err);
  }
}

/**
 * One current position fix. Always resolves (never rejects) — a permission
 * denial, a plugin/browser with no geolocation, or a timeout all come back as
 * a `FixError` the caller can switch on.
 */
export async function getFix(opts?: { timeoutMs?: number; maxAgeMs?: number }): Promise<Fix | FixError> {
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const maxAgeMs = opts?.maxAgeMs ?? 600_000;
  try {
    return isNativeLocation() ? await getNativeFix(timeoutMs, maxAgeMs) : await getWebFix(timeoutMs, maxAgeMs);
  } catch {
    // Belt-and-suspenders: getWebFix/getNativeFix already catch internally,
    // but a caller must never see a rejected promise from getFix.
    return { error: "unavailable" };
  }
}
