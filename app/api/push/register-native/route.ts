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
//
// Auth (the install token). A deviceId is not a secret, so a call that names a
// deviceId may only change that device's push target with the device's
// `x-install-token` header (401 `no-token`, nothing written, otherwise).
// A device row with no token on file yet may register once without one; that
// call atomically claims a token for the row BEFORE any write and returns it as
// `installToken` (once; the app stores it). Of two concurrent claimers exactly
// one wins; the other gets 401 and writes nothing.
// A call with no deviceId (old builds) only ever writes the "legacy:<token>"
// row, which is derived from the push token itself; holding that token is its
// proof, so it needs no install token.
// TODO(native-build): once no pre-deviceId build is left in the field, drop the
// legacy no-deviceId path.

import { getLocation } from "@/config/locations";
import { isDeviceId } from "@/lib/db/api";
import { checkInstallToken, claimInstallToken } from "@/lib/db/installTokenAuth";
import { getD1 } from "@/lib/db/d1Store";
import { attributeInstall, clientIp, fingerprint, fpSalt } from "@/lib/db/scanFunnel";
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

  const hasDeviceId = isDeviceId(body.deviceId);
  const id = hasDeviceId ? (body.deviceId as string) : legacyDeviceId(token);

  // Set only when THIS call claimed a fresh install token; returned to the app
  // (also on a 500, so the claim can never strand the phone without it).
  let installToken: string | undefined;

  try {
    const store = await getStore();

    // Install token gate (see the header). Runs before any read or write that
    // could change where this device's alerts go.
    if (hasDeviceId) {
      const auth = await checkInstallToken(store, id, req.headers.get("x-install-token"), Date.now());
      if (auth === "denied") return Response.json({ ok: false, error: "no-token" }, { status: 401 });
      if (auth === "unclaimed") {
        installToken = (await claimInstallToken(store, id, Date.now())) ?? undefined;
        // Another request claimed this row between our check and our claim.
        if (!installToken) return Response.json({ ok: false, error: "no-token" }, { status: 401 });
      }
    }

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

    // Turning on alerts is often the FIRST thing a fresh install writes, so
    // this is the second place a sticker scan can be redeemed (the other is
    // POST /api/devices). The SQL behind it decides for itself whether this
    // device qualifies, and it can only add a row to install_attrib — see
    // lib/db/scanFunnel.ts. A failure here costs a statistic, nothing else.
    try {
      const db = await getD1();
      if (db) {
        await attributeInstall(db, id, await fingerprint(clientIp(req), fpSalt()), Date.now());
      }
    } catch {
      // never let the funnel cost someone their alerts
    }
    return Response.json(installToken ? { ok: true, installToken } : { ok: true });
  } catch (e) {
    return Response.json({ error: String(e), ...(installToken ? { installToken } : {}) }, { status: 500 });
  }
}
