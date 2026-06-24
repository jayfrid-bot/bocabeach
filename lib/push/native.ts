// Client-side native (Capacitor/APNs) push helpers. Used by NotifyButton when
// the web app runs inside the iOS shell. All calls are guarded by
// isNativePlatform(), so they're inert in a normal browser; the
// @capacitor/push-notifications plugin is only imported on the native path.

import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import type { Token, RegistrationError, ActionPerformed } from "@capacitor/push-notifications";

/**
 * Resolve the runtime platform robustly. We load the live site inside the
 * Capacitor shell (server.url), and in that remote-URL setup the bundled
 * @capacitor/core singleton can latch onto "web" before the native bridge is
 * attached — so `Capacitor.getPlatform()` alone wrongly reports "web" and the
 * Notify button hides itself. We therefore also re-probe the live native
 * globals, which are present from webview creation and origin-independent:
 *   - window.webkit.messageHandlers.bridge → iOS  (WKWebView native handler)
 *   - window.androidBridge                  → Android
 *   - a custom user-agent tag (appendUserAgent in capacitor.config) as a final,
 *     build-stamped fallback that needs no Capacitor runtime at all.
 */
function detectPlatform(): "ios" | "android" | "web" {
  // 1. Bundled runtime — authoritative in a normal (bundled-assets) build.
  try {
    const p = Capacitor?.getPlatform?.();
    if (p === "ios" || p === "android") return p;
  } catch {
    /* fall through to live-global probes */
  }
  if (typeof window === "undefined") return "web";
  const w = window as unknown as {
    Capacitor?: { getPlatform?: () => string };
    webkit?: { messageHandlers?: { bridge?: unknown } };
    androidBridge?: unknown;
  };
  // 2. The injected bridge global (may differ from the bundled import on a
  //    remote URL, where it attaches after the bundle initialized).
  try {
    const p = w.Capacitor?.getPlatform?.();
    if (p === "ios" || p === "android") return p;
  } catch {
    /* ignore */
  }
  // 3. Raw native message-handler probes — independent of init timing.
  if (w.webkit?.messageHandlers?.bridge) return "ios";
  if (w.androidBridge) return "android";
  // 4. User-agent tag stamped by the native shell (see capacitor.config.ts).
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/IsItBeachDayApp\/(ios|android)/.test(ua)) {
    return ua.includes("IsItBeachDayApp/android") ? "android" : "ios";
  }
  return "web";
}

/** True only inside the Capacitor native app (false in any browser). */
export function isNativePlatform(): boolean {
  return detectPlatform() !== "web";
}

/** "ios" | "android" inside the app; "web" in a browser. */
export function nativePlatform(): "ios" | "android" | "web" {
  return detectPlatform();
}

const tokenKey = (slug: string) => `native-push:${slug}`;

/**
 * The native-injected Capacitor bridge (`window.Capacitor`), when present.
 *
 * This is the REAL bridge the WebView injects at creation time — it's what
 * actually talks to APNs/FCM. Crucially it is NOT always the same object as the
 * bundled `@capacitor/core` import: on the remote-URL shell the bundled
 * singleton can initialize in "web" mode before the native bridge attaches and
 * then never re-wire, so the BUNDLED `PushNotifications.requestPermissions()`
 * silently hangs and `isPluginAvailable()` reports "web → unavailable". The
 * injected bridge's plugin proxy does not have this problem (it captured a real
 * APNs token and delivered a push in testing), so we prefer it for every call.
 */
function nativeBridge(): {
  isPluginAvailable?: (n: string) => boolean;
  Plugins?: { PushNotifications?: typeof PushNotifications };
} | null {
  if (typeof window === "undefined") return null;
  const cap = (
    window as unknown as {
      Capacitor?: {
        isPluginAvailable?: (n: string) => boolean;
        Plugins?: { PushNotifications?: typeof PushNotifications };
      };
    }
  ).Capacitor;
  return cap ?? null;
}

// Resolve the PushNotifications plugin. Prefer the native-injected bridge proxy
// (proven to reach APNs on the remote-URL shell); fall back to the bundled
// import for normal bundled-asset builds and browsers. Statically referenced
// (no lazy chunk) so it's ready the instant the user taps.
async function plugin(): Promise<typeof PushNotifications> {
  const native = nativeBridge()?.Plugins?.PushNotifications;
  return native ?? PushNotifications;
}

/** "on" if registered for this beach, "denied" if perms blocked, else "off". */
export async function nativeStatus(slug: string): Promise<"on" | "off" | "denied"> {
  if (!isNativePlatform()) return "off";
  try {
    const PN = await plugin();
    const perm = await PN.checkPermissions();
    if (perm.receive === "denied") return "denied";
    return typeof localStorage !== "undefined" && localStorage.getItem(tokenKey(slug)) ? "on" : "off";
  } catch {
    return "off";
  }
}

/** Reject after `ms` if the promise hasn't settled. Bridge round-trips on the
 *  remote-URL shell can hang with no response — a clear error beats a spinner
 *  stuck on "Enabling…" forever. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

/** Request permission, register with APNs, and resolve the device token. */
async function registerForToken(): Promise<string> {
  // If the native plugin genuinely isn't registered in this build, bridge calls
  // hang with no response — fail fast with a readable reason. Check via the
  // injected bridge first: the bundled core can report "web" and wrongly claim
  // the plugin is unavailable even though the native shell has it registered.
  const bridge = nativeBridge();
  if (bridge?.isPluginAvailable) {
    if (!bridge.isPluginAvailable("PushNotifications")) {
      throw new Error("PushNotifications plugin isn't registered in this app build.");
    }
  } else if (typeof Capacitor.isPluginAvailable === "function" && !Capacitor.isPluginAvailable("PushNotifications")) {
    throw new Error("PushNotifications plugin isn't registered in this app build.");
  }
  const PN = await withTimeout(plugin(), 8000, "Loading the push module timed out.");
  const perm = await withTimeout(
    PN.requestPermissions(),
    8000,
    "iOS never answered the permission request (bridge round-trip stalled).",
  );
  if (perm.receive !== "granted") throw new Error("Notifications permission was not granted.");
  return new Promise<string>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (!done) {
        done = true;
        fn();
      }
    };
    const timer = setTimeout(() => finish(() => reject(new Error("Registration timed out."))), 10000);
    void PN.addListener("registration", (t: Token) =>
      finish(() => {
        clearTimeout(timer);
        resolve(t.value);
      }),
    );
    void PN.addListener("registrationError", (_e: RegistrationError) =>
      finish(() => {
        clearTimeout(timer);
        reject(new Error("Registration failed."));
      }),
    );
    void PN.register();
  });
}

/** Register this device for `slug` and persist the token server-side. */
export async function enableNative(
  slug: string,
  prefs: { morning: boolean; safety: boolean },
): Promise<void> {
  const token = await registerForToken();
  // "ios" → APNs token, "android" → FCM token; the server routes by platform.
  const platform = nativePlatform();
  const res = await fetch("/api/push/register-native", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug, token, platform, prefs }),
  });
  if (!res.ok) throw new Error(`Couldn't save your registration (${res.status}).`);
  try {
    localStorage.setItem(tokenKey(slug), token);
  } catch {
    /* private mode */
  }
}

/** Drop this device's registration for `slug` (server + local). */
export async function disableNative(slug: string): Promise<void> {
  let token = "";
  try {
    token = localStorage.getItem(tokenKey(slug)) ?? "";
  } catch {
    /* ignore */
  }
  if (token) {
    await fetch("/api/push/unregister-native", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }).catch(() => {});
  }
  try {
    localStorage.removeItem(tokenKey(slug));
  } catch {
    /* ignore */
  }
}

// Route a tapped notification to its beach. Registered once, app-wide.
let tapInit = false;
export async function initNativeTapHandling(): Promise<void> {
  if (!isNativePlatform() || tapInit) return;
  tapInit = true;
  try {
    const PN = await plugin();
    void PN.addListener("pushNotificationActionPerformed", (action: ActionPerformed) => {
      const url = (action?.notification?.data as { url?: string } | undefined)?.url;
      if (url) window.location.assign(url);
    });
  } catch {
    /* no-op off-device */
  }
}
