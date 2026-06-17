// POST /api/push/register-native — store a native app's push token for a beach.
// Body: { slug, token, platform: "ios"|"android", prefs?: { morning, safety } }.
// The token is only ever used as the destination for APNs/FCM sends (no SSRF
// surface); validated by platform-appropriate format + bounded length.

import { getLocation } from "@/config/locations";
import { getNativeSub, putNativeSub, type NativeSub } from "@/lib/push/nativeStore";

export const dynamic = "force-dynamic";

// iOS APNs tokens are hex (64 std, headroom allowed). Android FCM registration
// tokens are long and use base64url plus ':'.
const APNS_RE = /^[0-9a-fA-F]{32,256}$/;
const FCM_RE = /^[A-Za-z0-9_:-]{64,4096}$/;

interface Body {
  slug?: string;
  token?: string;
  platform?: string;
  prefs?: { morning?: unknown; safety?: unknown };
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

  // Preserve dedup state when the same device re-registers for the SAME beach.
  const existing = await getNativeSub(token).catch(() => null);

  const record: NativeSub = {
    token,
    platform,
    slug: loc.slug,
    tz: loc.timezone,
    prefs: {
      morning: body.prefs?.morning !== false,
      safety: body.prefs?.safety !== false,
    },
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    sent: existing && existing.slug === loc.slug ? existing.sent : undefined,
  };

  try {
    await putNativeSub(record);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
