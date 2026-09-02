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
  /** Dry now AND nothing expected within CLEAR_HORIZON_MIN. */
  clearingSoon: boolean;
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

/** Parse a `minutely_15` payload into a read for `nowMs`. Pure, so it is tested. */
export function parseMinutely(json: MinutelyPayload, nowMs: number): RainRead | null {
  const m = json?.minutely_15;
  const times = m?.time;
  if (!Array.isArray(times) || times.length === 0) return null;

  const precip = m?.precipitation ?? [];
  const prob = m?.precipitation_probability ?? [];
  const wet = (i: number): boolean => {
    const p = precip[i];
    const q = prob[i];
    if (typeof p === "number" && p > 0) return true;
    return typeof q === "number" && q >= WET_PROBABILITY;
  };

  let rainingNow = false;
  let eta: number | null = null;
  let anyAhead = false;
  let wetAhead = false;

  for (let i = 0; i < times.length; i++) {
    // Open-Meteo returns "YYYY-MM-DDThh:mm" in GMT; pin it to UTC explicitly
    // (same convention as lib/sources/hourlyForecast.ts).
    const start = Date.parse(`${times[i]}:00Z`);
    if (!Number.isFinite(start)) continue;
    const end = start + 15 * 60_000;
    if (end <= nowMs) continue; // already elapsed
    if (start <= nowMs) {
      if (wet(i)) rainingNow = true;
      continue;
    }
    const minutesOut = Math.round((start - nowMs) / 60_000);
    if (minutesOut >= CLEAR_HORIZON_MIN) break; // past the hour we speak for
    anyAhead = true;
    if (wet(i)) {
      wetAhead = true;
      if (eta == null) eta = minutesOut;
    }
  }

  if (!anyAhead && !rainingNow) return null; // nothing usable in the window
  return {
    etaMinutes: eta,
    rainingNow,
    clearingSoon: !rainingNow && anyAhead && !wetAhead,
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
    `&precipitation_unit=inch&forecast_days=1`;
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
