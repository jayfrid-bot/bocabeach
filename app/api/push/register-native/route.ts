// POST /api/push/register-native — store a native app's push token for a beach.
// Body: { slug, token, platform: "ios"|"android", prefs?: { morning, safety },
//         deviceId? }.
// The token is only ever used as the destination for APNs/FCM sends (no SSRF
// surface); validated by platform-appropriate format + bounded length.
//
// Storage moved from KV to the D1 device table (`lib/db/store.ts`). A client that
// sends its `deviceId` writes straight to its own row; an older build without one
// keeps writing to the synthetic "legacy:<token>" row, and the first call that
// DOES carry a deviceId adopts that legacy row's beach, prefs and dedup state,
// then deletes it. The response shape is unchanged.

import { getLocation } from "@/config/locations";
import { isDeviceId } from "@/lib/db/api";
import { isLegacyId, legacyDeviceId, prefsFromLegacy, getStore } from "@/lib/db/store";
import type { SentState } from "@/lib/db/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// iOS APNs tokens are hex (64 std, headroom allowed). Android FCM registration
// tokens are long and use base64url plus ':'.
const APNS_RE = /^[0-9a-fA-F]{32,256}$/;
const FCM_RE = /^[A-Za-z0-9_:-]{64,4096}$/;

interface Body {
  slug?: string;
  token?: string;
  platform?: string;
  prefs?: { morning?: unknown; safety?: unknown };
  deviceId?: string;
}

export async function POST(req: Request): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const loc = getLocation(typeof body.slug === "string" ? body.slug : "");
  if (!loc) return Response.json({ error: "unknown beach" }, { status: 400 });

  const platform = body.platform === "android" ? "android" : body.platform === "ios" ? "ios" : null;
  if (!platform) {
    return Response.json({ error: "platform must be ios or android" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token : "";
  const valid = platform === "ios" ? APNS_RE.test(token) : FCM_RE.test(token);
  if (!valid) {
    return Response.json({ error: "invalid device token" }, { status: 400 });
  }

  const id = isDeviceId(body.deviceId) ? body.deviceId : legacyDeviceId(token);

  try {
    const store = await getStore();

    // The row this token is already attached to, if any.
    const existing = await store.findByPushToken(token);

    let priorSlug: string | null = null;
    let priorSent: SentState = {};

    if (existing) {
      priorSlug = existing.homeSlug;
      priorSent = await store.getSent(existing.id);
      if (existing.id !== id) {
        // The token is moving to a different row. Carry the prefs across, then
        // make sure the old row can never be pushed to as well: a legacy row has
        // nothing else on it, so drop it; a real device row keeps its Plus state
        // and just loses the token.
        await store.upsertDevice(id, { prefs: existing.prefs });
        if (isLegacyId(existing.id)) await store.deleteDevice(existing.id);
        else await store.upsertDevice(existing.id, { pushToken: null });
      }
    }

    // Preserve dedup state when the same device re-registers for the SAME beach
    // (matches the pre-D1 behavior); a beach change starts clean.
    const sent = priorSlug === loc.slug ? priorSent : {};

    // The two coarse switches the native client sends only seed a BRAND-NEW
    // row. A device that already exists keeps its per-alert prefs (set through
    // /api/devices) — otherwise every tap on "Alerts" would expand the coarse
    // safety switch back into all-on and undo a single opt-out.
    const current = await store.getDevice(id);
    const seedPrefs = current
      ? {}
      : {
          prefs: prefsFromLegacy({
            morning: body.prefs?.morning !== false,
            safety: body.prefs?.safety !== false,
          }),
        };

    await store.upsertDevice(id, {
      platform,
      pushToken: token,
      tz: loc.timezone,
      homeSlug: loc.slug,
      ...seedPrefs,
      sent,
    });
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
