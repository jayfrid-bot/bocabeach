// POST /api/push/subscribe — save a browser's Web Push subscription for a beach.
// Body: { slug, prefs: { morning, safety }, subscription: PushSubscriptionJSON }.
// Open endpoint (a subscription isn't sensitive), but tightly validated:
//   - the beach must exist;
//   - the endpoint must be a real browser push service (allowlist) — this both
//     blocks SSRF (no internal/arbitrary hosts the sender would later POST to)
//     and bounds abuse to real push services;
//   - endpoint/keys are length- and charset-checked so a record can't be bloated.
// (Per-IP rate limiting is best enforced at the edge/CDN; see README/ops notes.)

import { getLocation } from "@/config/locations";
import { getSubscription, putSubscription, type StoredSub } from "@/lib/push/store";

export const dynamic = "force-dynamic";

// Hostnames the major browsers' push services live on. We only ever POST push
// payloads to the stored endpoint, so restricting to these prevents the sender
// from being aimed at internal/arbitrary hosts (SSRF) via a forged subscription.
const ALLOWED_PUSH_HOSTS = [
  "push.services.mozilla.com", // Firefox
  "fcm.googleapis.com", // Chrome / Chromium / Edge
  "android.googleapis.com", // legacy GCM/FCM
  "notify.windows.com", // Windows / WNS
  "push.apple.com", // Safari / iOS web push
];

function isAllowedEndpoint(raw: string): boolean {
  if (raw.length > 1024) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  return ALLOWED_PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

const B64URL = /^[A-Za-z0-9_-]+$/;
const validKey = (v: string, min: number, max: number) =>
  typeof v === "string" && v.length >= min && v.length <= max && B64URL.test(v);

interface Body {
  slug?: string;
  prefs?: { morning?: unknown; safety?: unknown };
  subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
}

export async function POST(req: Request): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const slug = typeof body.slug === "string" ? body.slug : "";
  const loc = getLocation(slug);
  if (!loc) return Response.json({ error: "unknown beach" }, { status: 400 });

  const sub = body.subscription;
  if (!sub || typeof sub.endpoint !== "string" || !isAllowedEndpoint(sub.endpoint)) {
    return Response.json({ error: "invalid or unsupported push endpoint" }, { status: 400 });
  }
  if (
    !sub.keys ||
    !validKey(sub.keys.p256dh ?? "", 80, 100) || // 65-byte EC point, base64url
    !validKey(sub.keys.auth ?? "", 16, 32) // 16-byte auth secret, base64url
  ) {
    return Response.json({ error: "invalid subscription keys" }, { status: 400 });
  }

  // Preserve dedup state when the same device re-subscribes to the SAME beach
  // (e.g. the NotifyButton re-subscribing), so the morning summary isn't resent.
  const existing = await getSubscription(sub.endpoint).catch(() => null);

  const record: StoredSub = {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh as string, auth: sub.keys.auth as string },
    slug: loc.slug,
    tz: loc.timezone,
    prefs: {
      // Default both on; only an explicit `false` disables.
      morning: body.prefs?.morning !== false,
      safety: body.prefs?.safety !== false,
    },
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    sent: existing && existing.slug === loc.slug ? existing.sent : undefined,
  };

  try {
    await putSubscription(record);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
