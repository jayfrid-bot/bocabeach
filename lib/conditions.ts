import { unstable_cache } from "next/cache";
import { getLocation, toPublicLocation } from "@/config/locations";
import type { ConditionsResponse, ConditionsSnapshot, HourlyMetrics, Location } from "@/lib/types";
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
import { fetchStingerSightings, type StingerSightings } from "@/lib/sources/stingerSightings";
import {
  anchorCurrentHourScore,
  computeHourlyScores,
  computeMultiDayWindows,
  computeScore,
  deriveMetrics,
} from "@/lib/score";
import { waterTrend } from "@/lib/waterTrend";
import { ripRiskCurve } from "@/lib/ripRiskCurve";
import { marineStinger } from "@/lib/marineStinger";
import { sharkContext } from "@/lib/sharkContext";
import { nowIso, round } from "@/lib/util";

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

/** The beach's LOCAL calendar month (1-12) + hour (0-23) at `now` — drives the
 *  season/dawn-dusk logic of the marine-stinger + shark-context advisories. */
function localMonthHour(tz: string, now: Date): { month: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    month: "numeric",
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  let hour = Number(parts.find((p) => p.type === "hour")?.value);
  if (hour === 24) hour = 0; // Intl can emit "24" for midnight
  return { month, hour };
}

/** The onshore component (mph) of the current wind at a beach with a known
 *  orientation — zero when the wind has any offshore component, or when a piece
 *  is missing. A turbidity signal for the shark-context read. */
function onshoreComponentMph(
  speedMph: number | undefined,
  windFromDeg: number | undefined,
  coastNormalDeg: number | undefined,
): number | undefined {
  if (speedMph == null || windFromDeg == null || coastNormalDeg == null) return undefined;
  const rad = ((windFromDeg - coastNormalDeg) * Math.PI) / 180;
  return Math.max(0, speedMph * Math.cos(rad));
}

/** Total precipitation (inches) over the trailing ~24h of hourly forecast — the
 *  runoff-turbidity signal for the shark-context read. */
function recentRainIn(hourly: HourlyMetrics[] | undefined, nowMs: number): number | undefined {
  if (!hourly?.length) return undefined;
  let sum = 0;
  let any = false;
  for (const h of hourly) {
    const t = Date.parse(h.time);
    if (!Number.isFinite(t) || t > nowMs || nowMs - t > 24 * 3_600_000) continue;
    if (typeof h.precipIn === "number") {
      sum += h.precipIn;
      any = true;
    }
  }
  return any ? round(sum, 2) : undefined;
}

/** Run a pure derivation non-fatally — a thrown module (never expected) degrades
 *  the one advisory to null rather than sinking the whole snapshot. */
function derive<T>(fn: () => T | null): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/**
 * The slug-free core of {@link getSnapshot}: fetch every source for an arbitrary
 * `Location` (configured or not) and assemble a snapshot. Used by the admin
 * console to preview a beach that isn't in the config yet.
 */
export async function getSnapshotForLocation(
  loc: Location,
): Promise<ConditionsSnapshot> {
  // Man-o'-war + shark advisories are SE-US-Atlantic-specific and need a real
  // shoreline orientation — only then do we bother iNaturalist for sightings.
  const atlanticOriented = loc.coast === "atlantic" && typeof loc.coastNormalDeg === "number";

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
    sightings,
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
    // Fail-soft: fetchStingerSightings already returns null on any failure, but
    // guard the promise too so nothing here can reject the Promise.all.
    atlanticOriented
      ? fetchStingerSightings(loc.lat, loc.lon).catch<StingerSightings | null>(() => null)
      : Promise.resolve<StingerSightings | null>(null),
  ]);

  const sun = fetchSun(loc);
  const base: ConditionsSnapshot = {
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
    sun,
    hourly,
  };

  // --- Derived informational advisories (never touch the Beach Day score) -----
  // Consensus current values (median across sources), the same numbers the
  // dashboard shows, so an advisory always agrees with the visible readings.
  const d = deriveMetrics(base);
  const nowD = new Date();
  const nowMs = nowD.getTime();
  const { month, hour } = localMonthHour(loc.timezone, nowD);
  const windSamples = (hourly.data ?? []).map((h) => ({
    time: h.time,
    windSpeedMph: h.windSpeedMph,
    windDirDeg: h.windDirDeg,
  }));

  // Water-"feel" trend — off the buoy's trailing water-temp history. General.
  const waterTrendData = derive(() =>
    waterTrend(buoy.data?.waterTempHistory ?? [], { nowMs }),
  );

  // Hourly rip-current risk curve — anchored on the official NWS word. General;
  // coastNormalDeg only adds the minor onshore-chop nudge when present.
  const ripRiskData = sun.data?.sunrise && sun.data?.sunset
    ? derive(() =>
        ripRiskCurve({
          officialLevel: nws.data?.ripCurrentRisk ?? "unknown",
          sunriseIso: sun.data!.sunrise!,
          sunsetIso: sun.data!.sunset!,
          waves: marine.data?.hourlyWaves,
          tideEvents: tides.data?.next,
          wind: windSamples,
          coastNormalDeg: loc.coastNormalDeg,
          tz: loc.timezone,
        }),
      )
    : null;

  // Man-o'-war + sea-lice advisory — SE-US-Atlantic beaches only (real
  // orientation required; elsewhere these two simply don't apply).
  const marineStingerData = atlanticOriented
    ? derive(() =>
        marineStinger({
          hourlyWind: windSamples,
          coastNormalDeg: loc.coastNormalDeg as number,
          month,
          sightings,
          waterTempF: d.waterTempF,
          now: nowD,
        }),
      )
    : null;

  // Seasonal shark context — same SE-US-Atlantic gate (sharkContext self-nulls
  // outside 24-35°N too, but we don't even call it for un-oriented beaches so a
  // Gulf-side FL beach in the same latitude band never shows Atlantic context).
  const sharkContextData = atlanticOriented
    ? derive(() =>
        sharkContext({
          month,
          latDeg: loc.lat,
          waterTempF: d.waterTempF,
          localHour: hour,
          recentWeather: {
            highSurf: d.waveHeightFt != null ? d.waveHeightFt >= 4 : undefined,
            onshoreWindMph: onshoreComponentMph(d.windSpeedMph, d.windDirDeg, loc.coastNormalDeg),
            recentRainIn: recentRainIn(hourly.data ?? undefined, nowMs),
          },
        }),
      )
    : null;

  return {
    ...base,
    waterTrend: waterTrendData,
    ripRisk: ripRiskData,
    marineStinger: marineStingerData,
    sharkContext: sharkContextData,
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
