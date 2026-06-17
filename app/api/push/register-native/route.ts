// POST /api/push/register-native — store a native iOS app's APNs device token
// for a beach. Body: { slug, token, platform?, prefs?: { morning, safety } }.
// Mirrors /subscribe (web). The token is only ever used as the APNs path to
// api.push.apple.com (no SSRF surface); validated as hex + bounded length.

import { getLocation } from "@/config/locations";
import { getNativeSub, putNativeSub, type NativeSub } from "@/lib/push/nativeStore";

export const dynamic = "force-dynamic";

// APNs device tokens are hex; standard length is 64 chars, but allow headroom.
const TOKEN_RE = /^[0-9a-fA-F]{32,256}$/;

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

  const token = typeof body.token === "string" ? body.token : "";
  if (!TOKEN_RE.test(token)) {
    return Response.json({ error: "invalid device token" }, { status: 400 });
  }
  if (body.platform !== undefined && body.platform !== "ios") {
    return Response.json({ error: "unsupported platform" }, { status: 400 });
  }

  // Preserve dedup state when the same device re-registers for the SAME beach.
  const existing = await getNativeSub(token).catch(() => null);

  const record: NativeSub = {
    token,
    platform: "ios",
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
