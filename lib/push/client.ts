// Client-side Web Push helpers. Used by the NotifyButton. All functions are
// browser-only and guard their feature use, so they're safe to import anywhere.

import { VAPID_PUBLIC_KEY } from "@/lib/push/vapid";

/** True when this browser can do Web Push (excludes iOS WKWebView / older UAs). */
export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** Convert a base64url VAPID public key to the Uint8Array the API expects. */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Request permission, subscribe via the active service worker's PushManager,
 * and POST the subscription to the server for `slug`. Returns the created
 * subscription. Throws with a friendly message on any failure.
 */
export async function subscribeToPush(
  slug: string,
  prefs: { morning: boolean; safety: boolean },
): Promise<PushSubscription> {
  if (!isPushSupported()) throw new Error("Notifications aren't supported on this device.");
  if (!VAPID_PUBLIC_KEY) throw new Error("Notifications aren't configured yet.");

  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications permission was not granted.");

  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
    }));

  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug, prefs, subscription: sub.toJSON() }),
  });
  if (!res.ok) throw new Error(`Couldn't save your subscription (${res.status}).`);
  return sub;
}

/** Unsubscribe locally and tell the server to drop the record. */
export async function unsubscribeFromPush(): Promise<void> {
  if (!isPushSupported()) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await fetch("/api/push/unsubscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

/** Current permission + whether an active push subscription exists. */
export async function pushStatus(): Promise<{
  permission: NotificationPermission | "unsupported";
  subscribed: boolean;
}> {
  if (!isPushSupported()) return { permission: "unsupported", subscribed: false };
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return { permission: Notification.permission, subscribed: !!sub };
}
