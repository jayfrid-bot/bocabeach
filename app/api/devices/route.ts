// /api/devices — the Plus device record.
//
//   POST { deviceId, platform?, tz?, homeSlug?, profile?, prefs?, previewSeen? }
//        Upsert. Only the fields present in the body change; `prefs` merges over
//        what is stored, so a client can flip one toggle. The FIRST call for a
//        device (any device with no `token_hash` on file yet) also mints an
//        install token and returns it as `installToken` — ONCE, never again.
//        The web layer stores it (lib/plus/storage.ts `bd:install-token`) and
//        sends it back as `x-install-token` on every Plus API call
//        (lib/plus/api.ts); this route and the other device-changing routes
//        require it once a device has a hash on file (see Auth below).
//   GET  ?deviceId=…   Read.
//
// Auth: the deviceId is a client-minted UUID but NOT a secret (it is the
// "Support ID"), so a POST for a device that already has a token on file needs
// the matching `x-install-token` header (401 `no-token` otherwise, nothing
// written). A device with no token on file yet may POST without one; that call
// mints and binds the token. GET stays open (read-only).

import { getLocation } from "@/config/locations";
import { badRequest, fail, isDeviceId, okDevice, readBody } from "@/lib/db/api";
import { getD1 } from "@/lib/db/d1Store";
import { attributeInstall, clientIp, fingerprint, fpSalt } from "@/lib/db/scanFunnel";
import { checkInstallToken, claimInstallToken } from "@/lib/db/installTokenAuth";
import { getStore } from "@/lib/db/store";
import {
  ALERT_KEYS,
  entitled,
  SUN_COLOR_LEAD_OPTIONS,
  type AlertPrefs,
  type DevicePatch,
} from "@/lib/db/types";
// The same validator the phone runs before it saves (lib/plus/storage.ts is
// pure and guards on `localStorage`, so it is safe here) — one definition of
// "a profile we accept", server and client.
import { cleanProfile } from "@/lib/plus/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_TZ = 64;

/**
 * A zone `Intl` can actually read. The push run formats every device's local
 * hour with it, and an unknown zone throws a RangeError there — so a made-up
 * string must never reach the column.
 */
function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Read the optional shared fields into a patch, or null when one is malformed. */
function patchFromBody(body: Record<string, unknown>): DevicePatch | null {
  const patch: DevicePatch = {};

  if (body.platform !== undefined) {
    const p = body.platform;
    if (p !== "ios" && p !== "android" && p !== "web") return null;
    patch.platform = p;
  }

  if (body.tz !== undefined) {
    if (typeof body.tz !== "string" || body.tz.length > MAX_TZ) return null;
    if (body.tz && !isTimeZone(body.tz)) return null;
    patch.tz = body.tz || null;
  }

  if (body.homeSlug !== undefined) {
    if (body.homeSlug === null) {
      patch.homeSlug = null;
    } else {
      if (typeof body.homeSlug !== "string" || !getLocation(body.homeSlug)) return null;
      patch.homeSlug = body.homeSlug;
    }
  }

  if (body.profile !== undefined) {
    if (body.profile === null) {
      patch.profile = null;
    } else {
      // Validated, not just shape-checked. The stored profile is fed straight to
      // resolveScoring() by the morning digest, where a `profiles` that is not an
      // array throws and an ideal band of strings scores every hour NaN — the
      // digest then goes out titled "Poor · NaN/100".
      const profile = cleanProfile(body.profile);
      if (!profile) return null;
      patch.profile = profile;
    }
  }

  if (body.prefs !== undefined) {
    if (!body.prefs || typeof body.prefs !== "object" || Array.isArray(body.prefs)) return null;
    const raw = body.prefs as Record<string, unknown>;
    const prefs: Partial<AlertPrefs> = {};
    for (const k of ALERT_KEYS) {
      if (raw[k] === undefined) continue;
      if (typeof raw[k] !== "boolean") return null;
      prefs[k] = raw[k] as boolean;
    }
    patch.prefs = prefs;
  }

  if (body.previewSeen !== undefined) {
    if (typeof body.previewSeen !== "boolean") return null;
    patch.previewSeen = body.previewSeen;
  }

  // The "sun-color" alert's two settings (migrations/0012_sun_color_prefs.sql)
  // — `null` resets either one to its default (lib/db/types.ts).
  if (body.sunColorMinBand !== undefined) {
    const v = body.sunColorMinBand;
    if (v !== null && v !== "vivid" && v !== "epic") return null;
    patch.sunColorMinBand = v;
  }
  if (body.sunColorLeadMin !== undefined) {
    const v = body.sunColorLeadMin;
    if (v !== null && !(SUN_COLOR_LEAD_OPTIONS as readonly unknown[]).includes(v)) return null;
    patch.sunColorLeadMin = v as number | null;
  }

  return patch;
}

export async function POST(req: Request): Promise<Response> {
  const body = await readBody(req);
  if (!body || !isDeviceId(body.deviceId)) return badRequest();
  const patch = patchFromBody(body);
  if (!patch) return badRequest();
  try {
    const store = await getStore();
    // Install token gate: a row that already has a token on file only accepts
    // writes from the phone that holds it. A row with none yet falls through
    // and claims one below.
    const auth = await checkInstallToken(store, body.deviceId, req.headers.get("x-install-token"), Date.now());
    if (auth === "denied") return fail("no-token", 401);

    // A personal-score profile is a Plus feature (2026-09 billing audit, item
    // 9). Onboarding saves one profile BEFORE purchase for its one-time
    // preview, so a device gets exactly one unpaid profile save; after the
    // preview has been seen, profile writes need an active grant. Every other
    // field on this route (platform, tz, homeSlug, prefs, previewSeen) stays
    // free.
    if (patch.profile !== undefined) {
      const existing = await store.getDevice(body.deviceId);
      const allowed = !existing || existing.previewSeen !== true || entitled(existing, Date.now());
      if (!allowed) return fail("not-entitled", 403);
    }

    // Install token identity (Codex review #1): a device row with no
    // token_hash yet gets one minted here (and in /api/push/register-native),
    // and the raw token is returned in `installToken` exactly once, in this
    // response, and never stored anywhere (only its sha256 hash is). The claim
    // happens BEFORE the write and is one atomic conditional UPDATE, so of two
    // first calls for the same id exactly one wins and the loser writes
    // nothing. A device that already has a hash gets nothing extra.
    let installToken: string | undefined;
    if (auth === "unclaimed") {
      installToken = (await claimInstallToken(store, body.deviceId, Date.now())) ?? undefined;
      if (!installToken) return fail("no-token", 401);
    }
    let device;
    try {
      device = await store.upsertDevice(body.deviceId, patch);
    } catch (e) {
      console.error("devices: upsert failed", e);
      // The claim already landed. Hand the token back anyway, or this phone
      // would be locked out of its own row.
      return Response.json(
        { ok: false, error: "store-unavailable", ...(installToken ? { installToken } : {}) },
        { status: 500 },
      );
    }

    // A brand-new native install may be the far end of a sticker scan. The SQL
    // behind this decides on its own whether this device qualifies (minutes
    // old, native, an unclaimed scan on the same network) — see
    // lib/db/scanFunnel.ts. It runs after the upsert so the row it checks is
    // already there, and it can only ever ADD a row to install_attrib, so a
    // failure here costs a statistic and nothing else.
    try {
      const db = await getD1();
      if (db) {
        await attributeInstall(
          db,
          body.deviceId,
          await fingerprint(clientIp(req), fpSalt()),
          Date.now(),
        );
      }
    } catch {
      // never let the funnel cost someone their device record
    }
    return okDevice(device, installToken ? { installToken } : undefined);
  } catch (e) {
    console.error("devices: upsert failed", e);
    return fail("store-unavailable", 500);
  }
}

export async function GET(req: Request): Promise<Response> {
  const deviceId = new URL(req.url).searchParams.get("deviceId") ?? "";
  if (!isDeviceId(deviceId)) return badRequest();
  try {
    const store = await getStore();
    const device = await store.getDevice(deviceId);
    if (!device) return fail("not-found", 404);
    return okDevice(device);
  } catch (e) {
    console.error("devices: read failed", e);
    return fail("store-unavailable", 500);
  }
}
