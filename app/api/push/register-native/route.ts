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
// `x-install-token` header (401 `no-token`, nothing written, otherwise). The
// phone makes the token itself and this route binds it, idempotently, in one
// conditional statement; an existing row that already has a push token but no
// install token yet is claimed only because THIS request carries that same push
// token as proof (lib/db/installTokenAuth.ts `authorizeMinting`).
//
// Moving the push token onto this device (a reinstall gets a new deviceId but
// keeps its APNs/FCM token, an old build's legacy row gets adopted) is ONE
// atomic store step (`store.transferPushToken`): every other row lets go of the
// token and this one takes it, or nothing changes. Holding the push token is
// what allows the move; push tokens are high-entropy and only ever known to the
// phone, APNs/FCM and our own database (docs/architecture.md, "Push-token
// transfer").
//
// A call with no deviceId (old builds) only ever writes the "legacy:<token>"
// row, derived from the push token itself, and needs no install token.
// TODO(native-build): drop that legacy path once no pre-deviceId build is left.

import { getLocation } from "@/config/locations";
import { isDeviceId, storeFailure } from "@/lib/db/api";
import { authorizeMinting } from "@/lib/db/installTokenAuth";
import { getD1 } from "@/lib/db/d1Store";
import { attributeInstall, clientIp, fingerprint, fpSalt } from "@/lib/db/scanFunnel";
import { isLegacyId, legacyDeviceId, prefsFromLegacy, getStore } from "@/lib/db/store";
import { NO_GUARD } from "@/lib/db/installGuard";
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

  // A supplied id shaped like a legacy one is not a real device id.
  const hasDeviceId = isDeviceId(body.deviceId) && !isLegacyId(body.deviceId as string);
  const id = hasDeviceId ? (body.deviceId as string) : legacyDeviceId(token);

  try {
    const store = await getStore();

    // Install token gate (see the header). Binds the token or refuses, before
    // any read or write that could change where this device's alerts go. Its
    // guard rides inside the write below.
    let guard = NO_GUARD;
    let minted: string | undefined;
    if (hasDeviceId) {
      const auth = await authorizeMinting(
        store,
        id,
        req.headers.get("x-install-token"),
        token, // the push token itself is the proof for a row that already has one
        "/api/push/register-native",
        Date.now(),
      );
      if (!auth.ok) return Response.json({ ok: false, error: "no-token" }, { status: 401 });
      guard = auth.guard;
      minted = auth.minted;
    }

    // The row this token is already attached to, if any (data only: its beach,
    // prefs and dedup state follow the token to its new home).
    const existing = await store.findByPushToken(token);

    let priorSlug: string | null = null;
    let priorSent: SentState = {};
    if (existing) {
      priorSlug = existing.homeSlug;
      priorSent = await store.getSent(existing.id);
    }

    // Preserve dedup state when the same device re-registers for the SAME beach
    // (matches the pre-D1 behavior); a beach change starts clean.
    const sent = priorSlug === loc.slug ? priorSent : {};

    // Prefs. A token that moves from another row carries that row's prefs
    // across. Otherwise the two coarse switches the native client sends only
    // seed a BRAND-NEW row: a device that already exists keeps its per-alert
    // prefs (set through /api/devices), or every tap on "Alerts" would expand
    // the coarse safety switch back into all-on and undo a single opt-out.
    const current = await store.getDevice(id);
    const moved = !!existing && existing.id !== id;
    const prefs = moved
      ? existing!.prefs
      : current
        ? undefined
        : prefsFromLegacy({
            morning: body.prefs?.morning !== false,
            safety: body.prefs?.safety !== false,
          });

    // One atomic step: the token leaves every other row and lands on this one.
    await store.transferPushToken(
      {
        id,
        token,
        patch: { platform, tz: loc.timezone, homeSlug: loc.slug, ...(prefs ? { prefs } : {}), sent },
      },
      guard,
    );

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
    return Response.json(minted ? { ok: true, installToken: minted } : { ok: true });
  } catch (e) {
    return storeFailure(e, "register-native: failed");
  }
}
