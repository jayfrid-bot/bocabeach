// The at-beach alert run: everyone who is standing on a beach right now, with
// the alerts they are due.
//
// Shape of one run:
//   listArmed(now)            → entitled devices inside a live presence window
//   ∩ listPushable()          → …that we can actually push to
//   load the strike feed ONCE → per device: strikes from THEIR fix
//   getConditions(slug)       → memoized per beach per run
//   rainForFix(...)           → memoized per beach (radar) or per cell (forecast)
//   evaluateAtBeach           → the pure rules
//   splitByDedup              → the 30-minute repeat window
//   claimSend + deliver + markAlert + markSent → claim, send, then remember
//
// External calls scale with occupied beaches and cells, not with people.
//
// One device's failure never sinks the run: it is caught, counted, and the next
// device is evaluated.

import { getConditions } from "@/lib/conditions";
import { getLocation } from "@/config/locations";
import { summarizeStrikes, type LightningFeed } from "@/lib/sources/lightning";
import { safetyAlertsEnabled } from "@/lib/push/notify";
import { haversineMiles } from "@/lib/util";
import { repeatWindow, sendClaimKey } from "@/lib/db/sendClaims";
import type { DeviceStore } from "@/lib/db/store";
import type { ArmedDevice, PushableDevice } from "@/lib/db/types";
import type { ConditionsResponse } from "@/lib/types";
import { evaluateAtBeach, RAIN_MEMORY_MS } from "@/lib/alerts/evaluate";
import { splitByDedup } from "@/lib/alerts/dedup";
import { loadLightningFeed } from "@/lib/alerts/lightningFeed";
import { newRainCache, rainForFix, type RainRead } from "@/lib/alerts/rain";

/** The push the caller actually sends. Mirrors `PushDecision` in lib/push/notify. */
export interface AtBeachPush {
  tag: string;
  title: string;
  body: string;
  url: string;
}

export interface AtBeachDeps {
  store: DeviceStore;
  /** Run time, ms. Injected so tests own the clock. */
  now: number;
  /**
   * Send one push. Return `dead: true` for a token the transport rejected as
   * gone; the run stops pushing to that device and reports it.
   */
  deliver: (sub: PushableDevice, msg: AtBeachPush) => Promise<{ ok: boolean; dead: boolean }>;
  /** Called once for a dead token, before the device is dropped from the run. */
  onDeadToken?: (sub: PushableDevice) => Promise<void>;
  /** Overridable feed loaders — the tests hand in fixtures instead of the network. */
  loadFeed?: () => Promise<LightningFeed | null>;
  loadConditions?: (slug: string) => Promise<ConditionsResponse | null>;
  loadRain?: (
    lat: number,
    lon: number,
    slug: string,
    nowMs: number,
    radar: ConditionsResponse["snapshot"]["precipRadar"] | null,
  ) => Promise<RainRead | null>;
}

export interface AtBeachCounts {
  /** Devices with a live presence window. */
  devices: number;
  /** …of those, the ones we ran the rules for. */
  evaluated: number;
  /** Pushes delivered. */
  sent: number;
  /**
   * Everything the run declined to send: a device with no usable push token or
   * an unknown beach, each alert held back by its repeat window, and each
   * alert lost to a concurrent run's send claim (#14).
   */
  skipped: number;
  /** Devices that threw. The run continued. */
  errors: number;
  /** Dead tokens dropped. */
  pruned: number;
}

const EMPTY: AtBeachCounts = { devices: 0, evaluated: 0, sent: 0, skipped: 0, errors: 0, pruned: 0 };

/**
 * A device fix older than this cannot be trusted to say where the person is
 * NOW — a phone that grabbed a fix at home, then walked around all day
 * without a foreground refresh, is not "at" wherever that fix pointed (#6).
 */
export const FIX_MAX_AGE_MS = 30 * 60 * 1000;
/** A fix worse than this (GPS-off, cell-tower-only) is not precise enough to
 *  place someone at one beach rather than the next one over. */
export const FIX_MAX_ACCURACY_M = 500;
/** A fix this far from the ARMED beach belongs to a different day, not this
 *  arm — manually monitoring a distant destination must not borrow it. */
export const FIX_MAX_DISTANCE_MI = 15 * 0.621371; // 15 km

export interface Fix {
  lat: number;
  lon: number;
  /** Where this fix came from — kept on the evaluated context for debugging
   *  a hazard that used the wrong geometry (#6). */
  fixSource: "device" | "beach";
}

/**
 * Where to measure hazard geometry from: the person's own fix when it is
 * fresh, accurate, and near the beach they armed — the beach centroid
 * otherwise, explicitly and every time (never a silent "whatever the fix
 * said"). Enforced server-side so a stale or distant client fix can never
 * widen (or wrongly narrow) who gets warned.
 */
export function fixOf(
  armed: ArmedDevice,
  fallback: { lat: number; lon: number },
  nowMs: number,
): Fix {
  const beach: Fix = { lat: fallback.lat, lon: fallback.lon, fixSource: "beach" };
  const { lat, lon, fixAt, accuracyM } = armed.presence;
  if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return beach;
  if (fixAt == null || !Number.isFinite(fixAt) || nowMs - fixAt > FIX_MAX_AGE_MS) return beach;
  if (accuracyM != null && Number.isFinite(accuracyM) && accuracyM > FIX_MAX_ACCURACY_M) return beach;
  if (haversineMiles(lat, lon, fallback.lat, fallback.lon) > FIX_MAX_DISTANCE_MI) return beach;
  return { lat, lon, fixSource: "device" };
}

/** The last time this device heard anything about rain (for "rain clearing"). */
async function recentRain(
  store: DeviceStore,
  deviceId: string,
  now: number,
): Promise<{ soonAt: number | null; wetAt: number | null }> {
  const [soon, wet] = await Promise.all([
    store.lastAlert(deviceId, "rain-soon"),
    store.lastAlert(deviceId, "rain-wet"),
  ]);
  const fresh = (at: number | undefined): number | null =>
    at != null && now - at <= RAIN_MEMORY_MS ? at : null;
  return { soonAt: fresh(soon?.sentAt), wetAt: fresh(wet?.sentAt) };
}

export async function runAtBeachAlerts(deps: AtBeachDeps): Promise<AtBeachCounts> {
  // The kill switch. Off means the engine does not even read the store.
  if (!safetyAlertsEnabled()) return { ...EMPTY };

  const { store, now } = deps;
  const counts: AtBeachCounts = { ...EMPTY };

  const armed = await store.listArmed(now); // entitled + inside the window already
  counts.devices = armed.length;
  if (!armed.length) return counts;

  const pushable = new Map<string, PushableDevice>();
  for (const p of await store.listPushable()) pushable.set(p.device.id, p);

  const loadConditions = deps.loadConditions ?? getConditions;
  const loadFeed = deps.loadFeed ?? loadLightningFeed;
  const rainCache = newRainCache();
  const loadRain =
    deps.loadRain ??
    ((lat, lon, slug, nowMs, radar) => rainForFix(lat, lon, slug, nowMs, rainCache, radar));

  // One feed for the whole run — every device summarizes it against its own fix.
  const feed = await loadFeed().catch(() => null);

  const conditionsBySlug = new Map<string, Promise<ConditionsResponse | null>>();
  const conditionsFor = (slug: string): Promise<ConditionsResponse | null> => {
    let hit = conditionsBySlug.get(slug);
    if (!hit) {
      hit = Promise.resolve(loadConditions(slug)).catch(() => null);
      conditionsBySlug.set(slug, hit);
    }
    return hit;
  };

  for (const device of armed) {
    const sub = pushable.get(device.device.id);
    const loc = getLocation(device.presence.slug);
    if (!sub || !loc) {
      counts.skipped += 1;
      continue;
    }
    try {
      const fix = fixOf(device, { lat: loc.lat, lon: loc.lon }, now);
      const conditions = await conditionsFor(device.presence.slug);
      const rain = await loadRain(
        fix.lat,
        fix.lon,
        device.presence.slug,
        now,
        conditions?.snapshot?.precipRadar ?? null,
      ).catch(() => null);

      // Remember a wet fix even when nothing is sent — it is what later makes
      // "rain clearing" a sentence a person recognizes.
      if (rain?.rainingNow) await store.markAlert(device.device.id, "rain-wet", now, { slug: device.presence.slug });

      const decisions = evaluateAtBeach({
        now,
        device: { prefs: device.device.prefs, profile: device.device.profile },
        presence: { slug: device.presence.slug, lat: fix.lat, lon: fix.lon, fixSource: fix.fixSource },
        beachName: loc.name,
        strikes: feed ? summarizeStrikes(feed, fix.lat, fix.lon, now) : null,
        rain,
        conditions,
        recentRain: await recentRain(store, device.device.id, now),
      });
      counts.evaluated += 1;

      const { fire, held, supersededKeys } = await splitByDedup(decisions, now, (key) =>
        store.lastAlert(device.device.id, key),
      );
      counts.skipped += held.length;

      // A superseded key still gets marked: the person just read the louder
      // version, so the quiet one must not arrive a run later.
      for (const key of supersededKeys) await store.markAlert(device.device.id, key, now);

      for (const d of fire) {
        // The concurrency guard beneath the dedup window above (#14): claim
        // this exact hazard, at this repeat window, before sending it. Two
        // runs racing each other (the Cloudflare 5-min cron and the GitHub
        // hourly backstop can both fire close together) both pass the dedup
        // check above if neither has written alert_log yet; only one of them
        // wins the claim, so only one actually sends.
        const claimKey = sendClaimKey(device.device.id, d.dedupKey, repeatWindow(now, d.repeatMs));
        if (!(await store.claimSend(claimKey, now))) {
          counts.skipped += 1;
          continue;
        }

        const r = await deps.deliver(sub, {
          tag: d.tag,
          title: d.title,
          body: d.body,
          url: `/${device.presence.slug}`,
        });
        if (r.dead) {
          counts.pruned += 1;
          await deps.onDeadToken?.(sub);
          break;
        }
        if (!r.ok) {
          // A transient failure leaves the dedup key AND the claim unmarked.
          // The claim looks "abandoned" (and so reclaimable) once it is 10
          // minutes old — see #14 — so this recovers on its own without
          // risking a duplicate send in the meantime.
          counts.errors += 1;
          continue;
        }
        counts.sent += 1;
        await store.markAlert(device.device.id, d.dedupKey, now, d.meta);
        await store.markSent(claimKey, now);
      }
    } catch (e) {
      counts.errors += 1;
      console.error("alerts: device failed", device.device.id, e);
    }
  }

  return counts;
}
