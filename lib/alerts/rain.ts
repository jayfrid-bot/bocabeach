// "Is it about to rain on the person standing here?" — the rain input to the
// at-beach alerts.
//
// Two sources, in order of honesty:
//  1. MRMS radar for the beach, when the FRAME is fresh (PRECIP_RADAR_STALE_MINUTES).
//     It is an observation, and the upstream job already did the advection math
//     that produces `etaMinutes`.
//  2. Open-Meteo `minutely_15` for the 0.05° cell containing the fix. A model,
//     but it is the only thing that answers "at MY spot" where radar is stale or
//     the beach is outside coverage.
//
// The cell, not the person, is the unit of work: fixes snap to ~3 mi cells
// before any external call, and one run fetches each occupied cell once. People
// cluster at beaches, so calls scale with cells, not with users.
//
// Never throws. A failure is `null` — "we do not know" — and the engine stays
// quiet rather than guessing.

import { cellCenter, cellKey } from "@/lib/location/cell";
import { RAIN_MM_HR } from "@/lib/rainNowcast";
import { PRECIP_RADAR_STALE_MINUTES } from "@/lib/sources/precipRadar";
import type { PrecipRadarData, Wrapped } from "@/lib/types";
import { fetchWithTimeout } from "@/lib/util";

/** How far ahead "clearing" has to hold for us to say the beach will dry out. */
export const CLEAR_HORIZON_MIN = 60;

/** Probability (%) at which a dry-looking 15-minute bucket counts as rain. */
const WET_PROBABILITY = 60;

export interface RainRead {
  /** Minutes until rain reaches the fix, or null when there is no honest answer. */
  etaMinutes: number | null;
  /** It is raining at the fix right now. */
  rainingNow: boolean;
  /** Dry now AND the whole CLEAR_HORIZON_MIN ahead is known and dry. */
  clearingSoon: boolean;
  /**
   * The forecast path's honesty flag (LOC-11): true only when every 15-minute
   * bucket from now through CLEAR_HORIZON_MIN was present and known. Radar
   * reads are one observation, so they leave it unset.
   */
  horizonKnown?: boolean;
  source: "radar" | "forecast";
}

/** One run's rain reads, keyed by beach (radar) or by cell (forecast). */
export type RainCache = Map<string, Promise<RainRead | null>>;

export function newRainCache(): RainCache {
  return new Map();
}

/** A fresh radar frame is an observation; a stale one is a story about the past. */
function radarIsFresh(radar: Wrapped<PrecipRadarData> | null | undefined): boolean {
  if (!radar || radar.status !== "ok" || !radar.data) return false;
  return radar.data.frameAgeMinutes <= PRECIP_RADAR_STALE_MINUTES;
}

function fromRadar(d: PrecipRadarData): RainRead {
  const rainingNow = d.rainNowMmHr != null && d.rainNowMmHr >= RAIN_MM_HR;
  // No ETA means the upstream track is dry or stalled — nothing is heading here.
  const clearingSoon = !rainingNow && d.etaMinutes == null;
  return { etaMinutes: d.etaMinutes, rainingNow, clearingSoon, source: "radar" };
}

interface MinutelyPayload {
  minutely_15?: {
    time?: string[];
    precipitation?: (number | null)[];
    precipitation_probability?: (number | null)[];
  };
}

/** One 15-minute step of the forecast. */
const STEP_MS = 15 * 60_000;

/** What one bucket says. "unknown" is a real answer — never rounded to dry. */
type Bucket = "wet" | "dry" | "unknown";

function bucketState(p: number | null | undefined, q: number | null | undefined): Bucket {
  const hasP = typeof p === "number" && Number.isFinite(p);
  const hasQ = typeof q === "number" && Number.isFinite(q);
  if (!hasP && !hasQ) return "unknown";
  if ((hasP && p > 0) || (hasQ && q >= WET_PROBABILITY)) return "wet";
  return "dry";
}

/**
 * Parse a `minutely_15` payload into a read for `nowMs`. Pure, so it is tested.
 *
 * Open-Meteo's 15-minute precipitation is an ACCUMULATION over the preceding
 * interval — a value stamped 13:15 describes 13:00–13:15 (LOC-10). So each
 * timestamp is the END of its bucket, and "now" lives in the bucket whose
 * `(end - 15 min, end]` window contains it. Probability rides along with the
 * same bucket.
 *
 * Three answers per bucket — wet, dry, unknown — and "clearing" is promised
 * only when every bucket from now through CLEAR_HORIZON_MIN is present,
 * contiguous and known-dry (LOC-11). A missing array, a null, a gap or a
 * feed that stops at midnight cannot say the sky is clearing; it can only
 * say we do not know.
 */
export function parseMinutely(json: MinutelyPayload, nowMs: number): RainRead | null {
  const m = json?.minutely_15;
  const times = m?.time;
  if (!Array.isArray(times) || times.length === 0) return null;

  const precip = Array.isArray(m?.precipitation) ? m.precipitation : [];
  const prob = Array.isArray(m?.precipitation_probability) ? m.precipitation_probability : [];

  const buckets: { start: number; end: number; state: Bucket }[] = [];
  for (let i = 0; i < times.length; i++) {
    // Open-Meteo returns "YYYY-MM-DDThh:mm" in GMT; pin it to UTC explicitly
    // (same convention as lib/sources/hourlyForecast.ts).
    const end = Date.parse(`${times[i]}:00Z`);
    if (!Number.isFinite(end)) continue;
    buckets.push({ start: end - STEP_MS, end, state: bucketState(precip[i], prob[i]) });
  }
  buckets.sort((a, b) => a.end - b.end);

  const horizonEnd = nowMs + CLEAR_HORIZON_MIN * 60_000;
  const current = buckets.find((b) => b.start <= nowMs && nowMs < b.end) ?? null;
  const nowState: Bucket = current?.state ?? "unknown";

  // The earliest KNOWN wet bucket ahead, inside the hour we speak for.
  let eta: number | null = null;
  let anyKnownAhead = false;
  for (const b of buckets) {
    if (b.start <= nowMs || b.start >= horizonEnd) continue;
    if (b.state === "unknown") continue;
    anyKnownAhead = true;
    if (b.state === "wet" && eta == null) eta = Math.round((b.start - nowMs) / 60_000);
  }

  // Coverage: walk contiguous known buckets from the current one until the
  // horizon is reached. Any hole — missing bucket, unknown value, feed that
  // ends early — leaves the horizon unknown.
  let horizonKnown = false;
  let wetInHorizon = false;
  if (current && current.state !== "unknown") {
    let cursor = current;
    let covered = cursor.end >= horizonEnd;
    while (!covered) {
      const next = buckets.find((b) => b.start === cursor.end);
      if (!next || next.state === "unknown") break;
      if (next.state === "wet") wetInHorizon = true;
      cursor = next;
      covered = cursor.end >= horizonEnd;
    }
    horizonKnown = covered;
  }

  if (nowState === "unknown" && !anyKnownAhead) return null; // nothing usable in the window

  const rainingNow = nowState === "wet";
  return {
    etaMinutes: rainingNow ? null : eta,
    rainingNow,
    clearingSoon: nowState === "dry" && horizonKnown && !wetInHorizon,
    horizonKnown,
    source: "forecast",
  };
}

async function fetchMinutely(rawLat: number, rawLon: number, nowMs: number): Promise<RainRead | null> {
  // 4 decimals is ~11 m — far finer than a 3-mile cell, and it keeps binary
  // floating point out of the URL (and out of the fetch cache key).
  const lat = Number(rawLat.toFixed(4));
  const lon = Number(rawLon.toFixed(4));
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&minutely_15=precipitation,precipitation_probability` +
    // Two days, not one: a run late in the UTC day would otherwise see its
    // 60-minute horizon cut off at midnight and could never say "clearing"
    // (LOC-11), or worse, mistake the truncation for a dry hour.
    `&precipitation_unit=inch&forecast_days=2`;
  try {
    const res = await fetchWithTimeout(url, {
      timeoutMs: 7000,
      next: { revalidate: 300 }, // 5 min — the cron cadence, not per-device
    });
    if (!res.ok) return null;
    return parseMinutely((await res.json()) as MinutelyPayload, nowMs);
  } catch {
    return null; // a rain alert is never worth an exception
  }
}

/**
 * The rain read for one device's fix. `radar` is the beach's MRMS wrapper from
 * the same run's conditions snapshot (already fetched once per beach).
 *
 * Results are memoized in `cache` for the whole run: per beach on the radar
 * path, per 0.05° cell on the forecast path.
 */
export async function rainForFix(
  lat: number,
  lon: number,
  slug: string,
  nowMs: number,
  cache: RainCache,
  radar?: Wrapped<PrecipRadarData> | null,
): Promise<RainRead | null> {
  if (radarIsFresh(radar)) {
    const key = `radar:${slug}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = Promise.resolve(fromRadar((radar as Wrapped<PrecipRadarData>).data as PrecipRadarData));
      cache.set(key, hit);
    }
    return hit;
  }

  const cell = cellKey(lat, lon);
  const key = `cell:${cell}`;
  let hit = cache.get(key);
  if (!hit) {
    const center = cellCenter(cell);
    hit = fetchMinutely(center.lat, center.lon, nowMs);
    cache.set(key, hit);
  }
  return hit;
}
