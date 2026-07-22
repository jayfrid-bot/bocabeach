import { unstable_cache } from "next/cache";
import { getLocation, toPublicLocation } from "@/config/locations";
import type { ConditionsResponse, ConditionsSnapshot, Location } from "@/lib/types";
import { buildCamViews } from "@/lib/cams";
import { fetchAirQuality } from "@/lib/sources/airQuality";
import { fetchBusyness } from "@/lib/sources/busyness";
import { fetchClarity } from "@/lib/sources/clarity";
import { fetchBuoy } from "@/lib/sources/buoy";
import { fetchCityOfficial } from "@/lib/sources/cityOfficial";
import { fetchForecast } from "@/lib/sources/forecast";
import { fetchHourlyForecast } from "@/lib/sources/hourlyForecast";
import { fetchLightning } from "@/lib/sources/lightning";
import { fetchMarine } from "@/lib/sources/marine";
import { fetchMetno } from "@/lib/sources/metno";
import { fetchGoesCloud } from "@/lib/sources/goesCloud";
import { fetchGfs } from "@/lib/sources/modelEnsemble";
import { fetchNowcast } from "@/lib/sources/nowcast";
import { fetchNws } from "@/lib/sources/nws";
import { fetchSargassum } from "@/lib/sources/sargassum";
import { fetchSun } from "@/lib/sources/sun";
import { fetchTides } from "@/lib/sources/tides";
import { fetchTraffic } from "@/lib/sources/traffic";
import { fetchWaterQuality } from "@/lib/sources/waterQuality";
import { fetchWeather } from "@/lib/sources/weather";
import {
  anchorCurrentHourScore,
  computeHourlyScores,
  computeMultiDayWindows,
  computeScore,
} from "@/lib/score";
import { nowIso } from "@/lib/util";

/**
 * Fetch every source for a location in parallel and assemble a snapshot.
 * Each source handles its own failures and returns a Wrapped<T> with a status,
 * so this never rejects — missing pieces simply render as "unavailable".
 */
export async function getSnapshot(
  slug: string,
): Promise<ConditionsSnapshot | null> {
  const loc = getLocation(slug);
  if (!loc) return null;
  return getSnapshotForLocation(loc);
}

/**
 * The slug-free core of {@link getSnapshot}: fetch every source for an arbitrary
 * `Location` (configured or not) and assemble a snapshot. Used by the admin
 * console to preview a beach that isn't in the config yet.
 */
export async function getSnapshotForLocation(
  loc: Location,
): Promise<ConditionsSnapshot> {
  const [
    tides,
    buoy,
    weather,
    marine,
    cityOfficial,
    waterQuality,
    nowcast,
    nws,
    airQuality,
    metno,
    gfs,
    lightning,
    goesCloud,
    sargassum,
    busyness,
    clarity,
    traffic,
    forecast,
    hourly,
  ] = await Promise.all([
    fetchTides(loc),
    fetchBuoy(loc),
    fetchWeather(loc),
    fetchMarine(loc),
    fetchCityOfficial(loc),
    fetchWaterQuality(loc),
    fetchNowcast(loc),
    fetchNws(loc),
    fetchAirQuality(loc),
    fetchMetno(loc),
    fetchGfs(loc),
    fetchLightning(loc),
    fetchGoesCloud(loc),
    fetchSargassum(loc),
    fetchBusyness(loc),
    fetchClarity(loc),
    fetchTraffic(loc),
    fetchForecast(loc),
    fetchHourlyForecast(loc),
  ]);

  return {
    location: toPublicLocation(loc),
    generatedAt: nowIso(),
    tides,
    buoy,
    weather,
    marine,
    cityOfficial,
    waterQuality,
    nowcast,
    nws,
    airQuality,
    metno,
    gfs,
    lightning,
    goesCloud,
    sargassum,
    busyness,
    clarity,
    traffic,
    forecast,
    sun: fetchSun(loc),
    hourly,
  };
}

/**
 * The heavy pipeline — 18 source fetches + full scoring over 192 hourly buckets
 * + multi-day windows — cached in the KV incremental cache (see
 * open-next.config.ts) for 120 s, keyed by slug and SHARED across every request
 * (page SSR + each client's `/api/conditions` poll). Before this, the
 * force-dynamic pages re-ran it per request and ran the worker over its resource
 * limit (Cloudflare 1102) under load. 120 s stale on the initial render is
 * imperceptible — the client SWR-refetches every 5 min — and the near-real-time
 * safety path (lightning push loop) is separate and unaffected.
 */
const cachedConditions = (slug: string) =>
  unstable_cache(
    () => getConditionsForLocation(getLocation(slug)!),
    ["conditions", slug],
    { revalidate: 120, tags: [`conditions-${slug}`] },
  )();

export async function getConditions(
  slug: string,
): Promise<ConditionsResponse | null> {
  const loc = getLocation(slug);
  if (!loc) return null;
  return cachedConditions(slug);
}

/**
 * The slug-free core of {@link getConditions}: build a full conditions response
 * (snapshot + score + hourly + cams) for an arbitrary `Location`. Powers the
 * admin live-preview of a beach before it's added to the config.
 */
export async function getConditionsForLocation(
  loc: Location,
): Promise<ConditionsResponse> {
  const [snapshot, cams] = await Promise.all([
    getSnapshotForLocation(loc),
    buildCamViews(loc).catch(() => []),
  ]);
  const score = computeScore(snapshot);
  const nowMs = Date.now();
  // The raw forecast curve (for the push's window analysis), and the same curve
  // with the current hour anchored to the headline (consensus) score so the chart's
  // "now" point matches the big number instead of diverging by the single-source gap.
  const hourlyForecast = computeHourlyScores(snapshot, nowMs);
  const hourlyScores = anchorCurrentHourScore(hourlyForecast, score, nowMs);
  const multiDayWindows = computeMultiDayWindows(snapshot, nowMs);
  // Keep the "Today" peak badge (DayOutlookStrip) >= the chart's anchored now-dot:
  // the live headline score IS part of today, so the day's advertised peak must
  // never read below the now-point (they're otherwise computed on different curves).
  const today = multiDayWindows[0];
  const nowDot = hourlyScores.find((h) => {
    const t = new Date(h.time).getTime();
    return t <= nowMs && nowMs < t + 3_600_000;
  });
  if (today && today.dow === "Today" && nowDot && today.peakScore != null && today.peakScore < nowDot.score) {
    multiDayWindows[0] = { ...today, peakScore: nowDot.score };
  }
  return { snapshot, score, hourlyScores, hourlyForecast, multiDayWindows, cams };
}
