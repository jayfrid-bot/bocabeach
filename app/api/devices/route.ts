// /api/devices — the Plus device record.
//
//   POST { deviceId, platform?, tz?, homeSlug?, profile?, prefs?, previewSeen? }
//        Upsert. Only the fields present in the body change; `prefs` merges over
//        what is stored, so a client can flip one toggle.
//   GET  ?deviceId=…   Read.
//
// No auth: the deviceId is a client-minted UUID, the same trust model as the
// push token. Nothing here is secret and nothing costs money.

import { getLocation } from "@/config/locations";
import { badRequest, fail, isDeviceId, okDevice, readBody } from "@/lib/db/api";
import { getStore } from "@/lib/db/store";
import { ALERT_KEYS, type AlertPrefs, type DevicePatch, type StoredProfile } from "@/lib/db/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_TZ = 64;

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
      if (typeof body.profile !== "object" || Array.isArray(body.profile)) return null;
      patch.profile = body.profile as StoredProfile;
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

  return patch;
}

export async function POST(req: Request): Promise<Response> {
  const body = await readBody(req);
  if (!body || !isDeviceId(body.deviceId)) return badRequest();
  const patch = patchFromBody(body);
  if (!patch) return badRequest();
  try {
    const store = await getStore();
    return okDevice(await store.upsertDevice(body.deviceId, patch));
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
