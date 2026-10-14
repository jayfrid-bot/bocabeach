// /api/devices — the Plus device record.
//
//   POST { deviceId, platform?, tz?, homeSlug?, profile?, prefs?, previewSeen?,
//          pushProof? }
//        Upsert. Only the fields present in the body change; `prefs` merges over
//        what is stored, so a client can flip one toggle.
//   GET  ?deviceId=…   Read.
//
// Auth. The deviceId is a client-minted UUID but NOT a secret (it is the
// "Support ID"). The phone makes its own install token, saves it, and sends it
// as `x-install-token`; this route binds it to the device (idempotently, so a
// retry or a lost response is harmless) and every write is guarded by it in the
// same statement (lib/db/installTokenAuth.ts `authorizeMinting`). A device row
// that already has a push token but no install token yet is claimed only if the
// request also carries that push token as `pushProof`. GET stays open (read
// only). With INSTALL_TOKEN_ENFORCE off, a request with no token still goes
// through as before and an older WebView is handed a server-made token once.

import { getLocation } from "@/config/locations";
import { badRequest, fail, isDeviceId, okDevice, readBody, storeFailure } from "@/lib/db/api";
import { getD1 } from "@/lib/db/d1Store";
import { attributeInstall, clientIp, fingerprint, fpSalt } from "@/lib/db/scanFunnel";
import { authorizeMinting } from "@/lib/db/installTokenAuth";
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
  const pushProof = typeof body.pushProof === "string" && body.pushProof.length <= 4096 ? body.pushProof : null;
  try {
    const store = await getStore();
    // Install token: bind it (idempotent) or refuse. Everything below is
    // guarded by the result, in the write itself.
    const auth = await authorizeMinting(
      store,
      body.deviceId,
      req.headers.get("x-install-token"),
      pushProof,
      "/api/devices",
      Date.now(),
    );
    if (!auth.ok) return fail("no-token", 401);

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

    const device = await store.upsertDevice(body.deviceId, patch, auth.guard);

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
    return okDevice(device, auth.minted ? { installToken: auth.minted } : undefined);
  } catch (e) {
    return storeFailure(e, "devices: write failed");
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
    return storeFailure(e, "devices: read failed");
  }
}
