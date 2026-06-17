// Client-side native (Capacitor/APNs) push helpers. Used by NotifyButton when
// the web app runs inside the iOS shell. All calls are guarded by
// isNativePlatform(), so they're inert in a normal browser; the
// @capacitor/push-notifications plugin is only imported on the native path.

import { Capacitor } from "@capacitor/core";
import type { Token, RegistrationError, ActionPerformed } from "@capacitor/push-notifications";

/** True only inside the Capacitor native app (false in any browser). */
export function isNativePlatform(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

const tokenKey = (slug: string) => `native-push:${slug}`;

async function plugin() {
  const mod = await import("@capacitor/push-notifications");
  return mod.PushNotifications;
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

/** Request permission, register with APNs, and resolve the device token. */
async function registerForToken(): Promise<string> {
  const PN = await plugin();
  const perm = await PN.requestPermissions();
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
  const platform = Capacitor.getPlatform();
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
