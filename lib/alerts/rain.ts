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
import { PRECIP_RADAR_STALE_MINUTES } from "@/lib/sources/precipRadar";
import type { PrecipRadarData, Wrapped } from "@/lib/types";
import { fetchWithTimeout } from "@/lib/util";
import { assessRain, RAIN_WET_MM_HR, type HazardAnchor } from "@/lib/hazards/assess";
// RAIN_WET_MM_HR is the one shared "is it raining" threshold (also used by
// lib/hazards/assess.ts's radar-wet check) — see its doc comment there.

/** The shape `assessRain` wants for the radar signal — built from whatever
 *  beach radar wrapper the caller has (fresh or stale; `assessRain` judges
 *  freshness itself, and a stale frame's `wetMinutesAgo` can still hold). */
type RadarInput = Parameters<typeof assessRain>[0]["radar"];

function radarInputOf(radar?: Wrapped<PrecipRadarData> | null): RadarInput {
  if (!radar) return null;
  return {
    status: radar.status,
    frameAgeMinutes: radar.data?.frameAgeMinutes,
    rainNowMmHr: radar.data?.rainNowMmHr,
    nearestRainKm: radar.data?.nearestRainKm,
    wetMinutesAgo: radar.data?.wetMinutesAgo,
  };
}

/** How far ahead "clearing" has to hold for us to say the beach will dry out. */
export const CLEAR_HORIZON_MIN = 60;

/** Probability (%) at which a dry-looking 15-minute bucket counts as rain. */
const WET_PROBABILITY = 60;

export interface RainRead {
  /** Minutes until rain reaches the fix, or null when there is no honest answer. */
  etaMinutes: number | null;
  /**
   * The literal observation: radar wet right now, or the nowcast bucket
   * raining right now. Never the assessment's latched hold — this is what
   * bookkeeping (the `rain-wet` mark, ETA erasure) must key off of.
   */
  rainingNow: boolean;
  /**
   * `assessRain(...).active` — the shared hazard's call, which stays true
   * through its hold window even when `rainingNow` has gone back to false.
   * This is what "is it raining, as a hazard" should read, e.g. to hold back
   * "clearing". Set on every read `rain.ts` itself produces (radar and
   * forecast paths); absent only on hand-built test fixtures predating it.
   */
  hazardActive?: boolean;
  /** `assessRain(...).latched` — hazardActive is true only via the hold, not
   *  a fresh observation this run. */
  latched?: boolean;
  /** Dry now AND the whole CLEAR_HORIZON_MIN ahead is known and dry. */
  clearingSoon: boolean;
  /**
   * The forecast path's honesty flag (LOC-11): true only when every 15-minute
   * bucket from now through CLEAR_HORIZON_MIN was present and known. Radar
   * reads are one observation, so they leave it unset.
   */
  horizonKnown?: boolean;
  source: "radar" | "forecast";
  /**
   * What this read's truth actually covers (Codex review, phase-1d): a beach
   * radar frame is beach-wide, not point-queryable, so it anchors to
   * `{kind:"beach"}` even when a device fix supplied the lat/lon that picked
   * that beach's radar. Only the cell-forecast path (Open-Meteo minutely for
   * the fix's own 0.05° cell) is honestly `{kind:"point"}`.
   */
  anchor?: HazardAnchor;
}

/** The raw per-cell forecast: the parsed minutely payload plus the nowcast
 *  bucket it carries. Nothing caller-specific (no radar, no assessment) may
 *  live here — two beaches sharing a cell must each get their own hazard
 *  call from their OWN radar (Codex round-2 #1). */
interface CellForecast {
  base: LiteralRead;
  nowcastState: "raining" | "dry" | null;
  corroborated: boolean;
}

/** One run's rain reads: per-beach radar assessments (each caller's own
 *  radar, so nothing to share), and per-cell raw forecasts (never a
 *  caller-specific assessment — see `CellForecast`). Two separate maps, not
 *  one keyed by prefix, so the forecast cache can never accidentally hold a
 *  per-caller `RainRead`. */
export interface RainCache {
  radar: Map<string, Promise<RainRead | null>>;
  cell: Map<string, Promise<CellForecast | null>>;
}

export function newRainCache(): RainCache {
  return { radar: new Map(), cell: new Map() };
}

/** A fresh radar frame is an observation; a stale one is a story about the past. */
function radarIsFresh(radar: Wrapped<PrecipRadarData> | null | undefined): boolean {
  if (!radar || radar.status !== "ok" || !radar.data) return false;
  return radar.data.frameAgeMinutes <= PRECIP_RADAR_STALE_MINUTES;
}

/** The literal fields a source can read on its own, before the shared
 *  assessment adds `hazardActive`/`latched`/`anchor`. */
type LiteralRead = Omit<RainRead, "hazardActive" | "latched" | "anchor">;

function fromRadar(d: PrecipRadarData): LiteralRead {
  const rainingNow = d.rainNowMmHr != null && d.rainNowMmHr >= RAIN_WET_MM_HR;
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
 * The same-bucket corroboration rule from `lib/score.ts`'s `deriveMetrics`
 * (`nowcastCorroborated`), scoped to what a 15-minute cell forecast can see on
 * its own: real measured precipitation, or a probability at/above the score's
 * 25% floor. score.ts also corroborates off cloud cover, the hour's weather
 * code, and nearby lightning — signals this per-cell read has no access to —
 * but a "wet" bucket already means real precip or prob>=60 (WET_PROBABILITY)
 * anyway, so this is always a subset of that rule, never a looser one.
 * Duplicated on purpose (not imported from score.ts, per the phase-1d plan).
 */
function nowcastFromPayload(
  json: MinutelyPayload,
  nowMs: number,
): { state: "raining" | "dry" | null; corroborated: boolean } {
  const m = json?.minutely_15;
  const times = m?.time;
  if (!Array.isArray(times)) return { state: null, corroborated: false };
  const precip = Array.isArray(m?.precipitation) ? m.precipitation : [];
  const prob = Array.isArray(m?.precipitation_probability) ? m.precipitation_probability : [];
  for (let i = 0; i < times.length; i++) {
    const end = Date.parse(`${times[i]}:00Z`);
    if (!Number.isFinite(end)) continue;
    const start = end - STEP_MS;
    if (start <= nowMs && nowMs < end) {
      const state = bucketState(precip[i], prob[i]);
      if (state === "unknown") return { state: null, corroborated: false };
      const corroborated = (precip[i] ?? 0) > 0 || (prob[i] ?? 0) >= 25;
      return { state: state === "wet" ? "raining" : "dry", corroborated };
    }
  }
  return { state: null, corroborated: false };
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
export function parseMinutely(json: MinutelyPayload, nowMs: number): LiteralRead | null {
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

/**
 * Fetch and parse one cell's minutely forecast. Pure of any caller — no
 * radar, no hazard assessment — so this is safe to cache and share across
 * every beach that lands in the same cell (Codex round-2 #1). The caller
 * builds its own `RainRead` (and its own `assessRain` call, off its own
 * radar) from what this returns.
 */
async function fetchMinutely(
  rawLat: number,
  rawLon: number,
  nowMs: number,
): Promise<CellForecast | null> {
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
    const json = (await res.json()) as MinutelyPayload;
    const base = parseMinutely(json, nowMs);
    if (!base) return null;
    const { state, corroborated } = nowcastFromPayload(json, nowMs);
    return { base, nowcastState: state, corroborated };
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
  const cell = cellKey(lat, lon);
  const radarInput = radarInputOf(radar);

  if (radarIsFresh(radar)) {
    // MRMS radar is a BEACH-WIDE frame, not point-queryable today (phase-1d
    // spec: reuse the beach radar) — a fix up to 15 km away still reads the
    // same frame, so the anchor must say "beach", never "point" (Codex
    // review), or the attribution would claim a precision this data doesn't
    // have.
    const anchor: HazardAnchor = { kind: "beach", slug };
    const key = slug;
    let hit = cache.radar.get(key);
    if (!hit) {
      hit = (async () => {
        const base = fromRadar((radar as Wrapped<PrecipRadarData>).data as PrecipRadarData);
        // Same shared truth as the forecast path below — only here the radar
        // is fresh, so there is no nowcast bucket to corroborate against.
        const assessment = assessRain({
          radar: radarInput,
          nowcastState: null,
          corroborated: false,
          stormSignal: false,
          nowMs,
          anchor,
        });
        return { ...base, hazardActive: assessment.active, latched: assessment.latched, anchor };
      })();
      cache.radar.set(key, hit);
    }
    return hit;
  }

  // Only here — the fix's own 0.05° cell forecast — is a point anchor honest.
  const anchor: HazardAnchor = { kind: "point", lat, lon, cell };

  // The raw cell forecast is cached and shared (per cell, not per caller —
  // Codex round-2 #1). It carries no radar and no assessment, so two beaches
  // sharing a cell can never inherit or lose each other's rain hold.
  let hit = cache.cell.get(cell);
  if (!hit) {
    const center = cellCenter(cell);
    hit = fetchMinutely(center.lat, center.lon, nowMs);
    cache.cell.set(cell, hit);
  }
  const forecast = await hit;

  // Assess the radar latch first, independent of the forecast (Codex
  // round-2 #2): a forecast fetch/parse failure must never cost a caller a
  // still-valid `wetMinutesAgo` hold. When the forecast IS available, its
  // nowcast bucket is merged in exactly as before.
  const assessment = assessRain({
    radar: radarInput,
    nowcastState: forecast?.nowcastState ?? null,
    corroborated: forecast?.corroborated ?? false,
    // No weather-code/short-forecast text at cell granularity — a per-cell
    // rain read has no honest storm signal to offer.
    stormSignal: false,
    nowMs,
    anchor,
  });

  if (!forecast) {
    // No honest ETA/clearing without a forecast — only the radar latch
    // (if any) survives. Nothing to report if even that isn't active.
    if (!assessment.active) return null;
    const rainingNow = radarInput?.rainNowMmHr != null && radarInput.rainNowMmHr >= RAIN_WET_MM_HR;
    return {
      etaMinutes: null,
      rainingNow,
      clearingSoon: false,
      hazardActive: assessment.active,
      latched: assessment.latched,
      source: "radar",
      anchor,
    };
  }

  // `forecast.base`'s literal rainingNow/etaMinutes/clearingSoon (the
  // nowcast bucket itself) are left exactly as parsed — only the hazard
  // call comes from the shared assessment (phase 1d), so a push and the
  // score cap read the same cell radar + nowcast the same way without
  // erasing the honest ETA.
  return {
    ...forecast.base,
    hazardActive: assessment.active,
    latched: assessment.latched,
    anchor,
  };
}
