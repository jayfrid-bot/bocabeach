// Client-side native (Capacitor/APNs) push helpers. Used by NotifyButton when
// the web app runs inside the iOS shell. All calls are guarded by
// isNativePlatform(), so they're inert in a normal browser; the
// @capacitor/push-notifications plugin is only imported on the native path.

import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import type { Token, RegistrationError, ActionPerformed } from "@capacitor/push-notifications";
import { getDeviceId } from "@/lib/deviceId";
import {
  clearPendingUnregister,
  queuePendingUnregister,
  readInstallToken,
  readPendingUnregister,
  writeInstallClaimed,
} from "@/lib/plus/storage";
import { clientCapHeaders } from "@/lib/plus/clientCap";

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
// import for normal bundled-asset builds and browsers.
//
// CRITICAL: this is SYNCHRONOUS, and callers must NOT pass its return value
// through `await`, `Promise.race`, or `Promise.resolve`. Capacitor's plugin
// proxy traps EVERY property access — including `.then` — as a native method
// call. If the proxy reaches Promise-resolution machinery, JS sees a "thenable",
// calls its `.then(resolve, reject)`, that routes to a non-existent native
// "then" method which never calls back, and the await hangs forever. That was
// the real "Loading the push module timed out" bug: returning the proxy from an
// `async` function is enough to trigger it. Only the plugin's actual method
// calls (requestPermissions / register / checkPermissions / addListener), which
// return genuine Promises, may be awaited.
function getPlugin(): typeof PushNotifications {
  return nativeBridge()?.Plugins?.PushNotifications ?? PushNotifications;
}

/** "on" if registered for this beach, "denied" if perms blocked, else "off". */
export async function nativeStatus(slug: string): Promise<"on" | "off" | "denied"> {
  if (!isNativePlatform()) return "off";
  try {
    const PN = getPlugin();
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
  // Resolve the plugin synchronously — NEVER `await` the proxy itself (see
  // getPlugin: awaiting a plugin proxy hangs on its `.then` trap). Only its
  // method calls below, which return real Promises, are awaited.
  const PN = getPlugin();
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

/**
 * Make sure the server holds this phone's install token before a push change
 * goes out. The phone makes the token and saves it first; the claim is
 * idempotent. Imported lazily because lib/plus/installToken.ts imports this
 * file (a static import would be circular). Resolves null when the token could
 * not be kept or claimed; the register call below then fails with a plain
 * message rather than send something the server will refuse.
 */
async function claimedInstallToken(): Promise<string | null> {
  try {
    const { claimInstallToken } = await import("@/lib/plus/installToken");
    return (await claimInstallToken()).token;
  } catch {
    return null;
  }
}

const NOT_YOUR_PHONE = "We could not confirm this is your phone. Close and reopen the app, then try again.";

/** POST a push-route body with the install token header (when there is one). */
function postPush(path: string, body: unknown, installToken: string | null): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...clientCapHeaders(),
      ...(installToken ? { "x-install-token": installToken } : {}),
    },
    body: JSON.stringify(body),
  });
}

// --- One operation at a time, app-wide ------------------------------------------
//
// Turning alerts on, turning them off, and retrying a turn-off that did not get
// through all change the same server row (one device per app install, and the
// row is keyed by the device id, not by the push token). Run in any order they
// can undo each other. So the WHOLE lifecycle of each goes through ONE queue,
// including getting the push token from the OS (which can take seconds and a
// permission prompt).
//
// Every enable and disable takes a generation number ONCE, when it is asked
// for. Each step of it checks, before it does anything that reaches the server,
// whether a newer enable or disable has been asked for since, and if so drops
// out. So the latest thing the person asked for wins, even when an older enable
// is still waiting on APNs/FCM: it wakes up, sees it was overtaken, and sends
// nothing. A step that has ALREADY reached the server never drops out half way:
// the local marker is always written, so the disable queued behind it knows what
// to turn off.

let queueTail: Promise<void> = Promise.resolve();
/** The generation of the latest enable or disable asked for. Bumped only at the
 *  moment one is asked for, never inside a continuation. */
let intentSeq = 0;

function runSerial<T>(op: () => Promise<T>): Promise<T> {
  const run = queueTail.then(op, op);
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Resolves when every enable, disable and retry asked for so far has finished. */
export function whenPushIdle(): Promise<void> {
  return queueTail;
}

/** Test-only: forget queued operations between tests. */
export function resetPushOps(): void {
  queueTail = Promise.resolve();
  intentSeq = 0;
  flushRunning = null;
  flushAgain = false;
}

/** Remove every `native-push:<slug>` marker whose value passes `drop`. */
function removeMarkers(drop: (value: string) => boolean): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith("native-push:") && drop(localStorage.getItem(k) ?? "")) localStorage.removeItem(k);
    }
  } catch {
    /* private mode */
  }
}

/**
 * Register this device for `slug` and persist the token server-side. Resolves
 * "on" when it did, or "superseded" when a newer enable or disable was asked
 * for before it reached the server (nothing was sent).
 */
export async function enableNative(
  slug: string,
  prefs: { morning: boolean; safety: boolean },
): Promise<"on" | "superseded"> {
  const gen = ++intentSeq; // taken once; no continuation takes another
  return runSerial(async () => {
    if (gen !== intentSeq) return "superseded";
    const token = await registerForToken();
    // Overtaken while waiting on the OS: send nothing.
    if (gen !== intentSeq) return "superseded";
    // "ios" → APNs token, "android" → FCM token; the server routes by platform.
    const platform = nativePlatform();
    // The Plus device id ties this push token to THIS device's row (profile,
    // entitlement, alert prefs). Without it the server has to keep the token on a
    // synthetic "legacy:<token>" row instead; sending it lets that row be merged
    // and dropped. "" (storage disabled) is omitted so the server keeps the
    // legacy path rather than rejecting the body.
    const deviceId = getDeviceId();
    const body = { slug, token, platform, prefs, ...(deviceId ? { deviceId } : {}) };
    // The server only lets the phone that holds the device's install token
    // change where its alerts go. Claim it first (the claim waits for any claim
    // already running); the register call itself also carries the token and the
    // push token as proof, so it binds one on its own if the claim could not.
    const installToken = deviceId ? await claimedInstallToken() : null;
    if (gen !== intentSeq) return "superseded";
    const res = await postPush("/api/push/register-native", body, installToken ?? readInstallToken());
    // From here the server may already be ON: always leave the marker behind.
    if (res.status === 401) throw new Error(NOT_YOUR_PHONE);
    if (!res.ok) throw new Error(`Couldn't save your registration (${res.status}).`);
    // Record "claimed" only when the server says it bound this token.
    try {
      const j = (await res.clone().json()) as { installTokenBound?: unknown } | null;
      if (j?.installTokenBound === true) writeInstallClaimed(true);
    } catch {
      /* no body */
    }
    try {
      localStorage.setItem(tokenKey(slug), token);
    } catch {
      /* private mode */
    }
    // A turn-off that never reached the server is not wanted any more, and an
    // older marker for a different push token would only be a stale proof.
    clearPendingUnregister(token);
    removeMarkers((v) => v !== token);
    return "on";
  });
}

/** Send one unregister. "ok": the server dropped it. "refused": it will keep
 *  refusing. "retry": the network or the server failed (including a failed
 *  delete on the server, which it reports as an error, never as success). */
async function sendUnregister(token: string, deviceId: string): Promise<"ok" | "refused" | "retry"> {
  try {
    // The push token IS the authorization for turning alerts off; the install
    // token is sent too, but the server does not need it.
    const res = await postPush(
      "/api/push/unregister-native",
      { token, ...(deviceId ? { deviceId } : {}) },
      readInstallToken(),
    );
    if (res.ok) return "ok";
    return res.status === 401 ? "refused" : "retry";
  } catch {
    return "retry";
  }
}

let flushRunning: Promise<void> | null = null;
let flushAgain = false;

/** One pass over the queued turn-offs, each as a job on the app-wide queue. A job
 *  re-reads the queue when it runs, so one an enable already cleared is skipped. */
async function flushPass(): Promise<void> {
  const deviceId = getDeviceId();
  await Promise.all(
    readPendingUnregister().map((token) =>
      runSerial(async () => {
        if (!readPendingUnregister().includes(token)) return;
        if ((await sendUnregister(token, deviceId)) !== "ok") return;
        clearPendingUnregister(token);
        removeMarkers((v) => v === token); // the per-beach "on" markers for it
      }),
    ),
  );
}

/**
 * Retry every turn-off that did not reach the server. Safe to call often. A
 * call that arrives while a pass is running does not join its old snapshot: it
 * schedules ONE more pass after it, and resolves when that pass is done.
 */
export function flushPendingUnregister(): Promise<void> {
  if (flushRunning) {
    flushAgain = true;
    return flushRunning;
  }
  const run = (async () => {
    try {
      do {
        flushAgain = false;
        await flushPass().catch(() => {});
      } while (flushAgain);
    } finally {
      flushRunning = null;
    }
  })();
  flushRunning = run;
  return run;
}

/**
 * Drop this device's registration for `slug` (server + local). Alerts stay
 * shown as ON until the server has confirmed: if the call does not get through
 * (offline, server trouble) it is saved and retried, and this throws a plain
 * message so the screen can say so. A 401 will not fix itself, so it is not
 * retried; it throws too. A newer enable or disable asked for before this ran
 * wins: this one then does nothing.
 */
export async function disableNative(slug: string): Promise<void> {
  const gen = ++intentSeq;
  await runSerial(async () => {
    if (gen !== intentSeq) return;
    // Read INSIDE the queue: an enable ahead of this may just have registered.
    let token = "";
    try {
      token = localStorage.getItem(tokenKey(slug)) ?? "";
    } catch {
      /* ignore */
    }
    if (token) {
      const result = await sendUnregister(token, getDeviceId());
      if (result === "refused") throw new Error(NOT_YOUR_PHONE);
      if (result === "retry") {
        queuePendingUnregister(token);
        throw new Error(
          "Couldn't turn alerts off just yet. We will keep trying, and they stay on until it goes through.",
        );
      }
    }
    try {
      localStorage.removeItem(tokenKey(slug));
    } catch {
      /* ignore */
    }
  });
}

// Route a tapped notification to its beach. Registered once, app-wide.
let tapInit = false;
export async function initNativeTapHandling(): Promise<void> {
  if (!isNativePlatform() || tapInit) return;
  tapInit = true;
  try {
    const PN = getPlugin();
    void PN.addListener("pushNotificationActionPerformed", (action: ActionPerformed) => {
      const url = (action?.notification?.data as { url?: string } | undefined)?.url;
      if (url) window.location.assign(url);
    });
  } catch {
    /* no-op off-device */
  }
}
