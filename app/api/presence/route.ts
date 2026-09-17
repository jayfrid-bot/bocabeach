// /api/presence — "I'm at this beach right now", the gate for safety alerts.
//
//   POST   { deviceId, slug, lat, lon, accuracyM, fixAt, armedUntil, source }
//          Arms a window. Plus only (403 not-entitled). `armedUntil` is clamped
//          to at most MAX_ARM_MS ahead, so a bad clock or a stale client can
//          never leave a device armed for days. A supplied `fixAt` more than
//          a minute in the future, or a supplied `accuracyM` that is not a
//          number in range, is a 400 — never silently turned into "unknown"
//          (LOC-09). Answers `pushReady` alongside the device: monitoring is
//          armed, but alerts only reach a phone with a registered push token
//          (LOC-03), and the card must not claim otherwise.
//   DELETE { deviceId }  (or ?deviceId=…)  Disarms.
//
// The stored fix is what the alerts engine uses for per-device lightning
// distance, so it is deliberately short-lived and never returned to any client.

import { getLocation } from "@/config/locations";
import { badRequest, fail, isDeviceId, num, okDevice, readBody } from "@/lib/db/api";
import { getStore } from "@/lib/db/store";
import { entitled } from "@/lib/db/types";
import { MAX_ARM_MS } from "@/lib/db/plus";
import { FIX_MAX_FUTURE_SKEW_MS } from "@/lib/alerts/run";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const body = await readBody(req);
  if (!body || !isDeviceId(body.deviceId)) return badRequest();

  const slug = typeof body.slug === "string" ? body.slug : "";
  if (!getLocation(slug)) return badRequest();

  const source = body.source === "auto" ? "auto" : body.source === "manual" ? "manual" : null;
  if (!source) return badRequest();

  const armedRaw = num(body.armedUntil, 0, Number.MAX_SAFE_INTEGER);
  if (armedRaw === null) return badRequest();

  const lat = body.lat === undefined || body.lat === null ? null : num(body.lat, -90, 90);
  const lon = body.lon === undefined || body.lon === null ? null : num(body.lon, -180, 180);
  if ((body.lat !== undefined && body.lat !== null && lat === null) ||
      (body.lon !== undefined && body.lon !== null && lon === null)) {
    return badRequest();
  }
  const now = Date.now();
  // LOC-09: a malformed precision or timestamp is a bad request, not a quiet
  // null — "unknown accuracy" must mean the client reported none, never that
  // it reported garbage.
  const accuracyM =
    body.accuracyM === undefined || body.accuracyM === null ? null : num(body.accuracyM, 0, 1e6);
  if (body.accuracyM !== undefined && body.accuracyM !== null && accuracyM === null) return badRequest();
  const fixAt =
    body.fixAt === undefined || body.fixAt === null
      ? null
      : num(body.fixAt, 0, now + FIX_MAX_FUTURE_SKEW_MS);
  if (body.fixAt !== undefined && body.fixAt !== null && fixAt === null) return badRequest();

  const armedUntil = Math.min(Math.max(armedRaw, now), now + MAX_ARM_MS);

  try {
    const store = await getStore();
    const device = await store.getDevice(body.deviceId);
    if (!device || !entitled(device, now)) return fail("not-entitled", 403);

    await store.setPresence(body.deviceId, {
      slug,
      lat,
      lon,
      accuracyM,
      fixAt,
      armedUntil,
      source,
    });
    const updated = await store.getDevice(body.deviceId);
    // Delivery readiness is a separate fact from monitoring (LOC-03).
    const pushReady = !!(await store.getPushToken(body.deviceId));
    return okDevice(updated ?? device, { pushReady });
  } catch (e) {
    console.error("presence: arm failed", e);
    return fail("store-unavailable", 500);
  }
}

export async function DELETE(req: Request): Promise<Response> {
  // Accept the id in the body (fetch allows a body on DELETE) or the query.
  const body = await readBody(req);
  const fromQuery = new URL(req.url).searchParams.get("deviceId") ?? "";
  const deviceId = body && isDeviceId(body.deviceId) ? body.deviceId : fromQuery;
  if (!isDeviceId(deviceId)) return badRequest();

  try {
    const store = await getStore();
    const device = await store.getDevice(deviceId);
    if (!device) return fail("not-found", 404);
    await store.clearPresence(deviceId);
    return okDevice({ ...device, presence: null });
  } catch (e) {
    console.error("presence: disarm failed", e);
    return fail("store-unavailable", 500);
  }
}
