import { getLocation, toPublicLocation } from "@/config/locations";
import type { ConditionsResponse, ConditionsSnapshot } from "@/lib/types";
import { buildCamViews } from "@/lib/cams";
import { fetchBuoy } from "@/lib/sources/buoy";
import { fetchCityOfficial } from "@/lib/sources/cityOfficial";
import { fetchForecast } from "@/lib/sources/forecast";
import { fetchHourlyForecast } from "@/lib/sources/hourlyForecast";
import { fetchMarine } from "@/lib/sources/marine";
import { fetchSun } from "@/lib/sources/sun";
import { fetchTides } from "@/lib/sources/tides";
import { fetchWaterQuality } from "@/lib/sources/waterQuality";
import { fetchWeather } from "@/lib/sources/weather";
import { computeHourlyScores, computeScore } from "@/lib/score";
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

  const [tides, buoy, weather, marine, cityOfficial, waterQuality, forecast, hourly] =
    await Promise.all([
      fetchTides(loc),
      fetchBuoy(loc),
      fetchWeather(loc),
      fetchMarine(loc),
      fetchCityOfficial(loc),
      fetchWaterQuality(loc),
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
    forecast,
    sun: fetchSun(loc),
    hourly,
  };
}

export async function getConditions(
  slug: string,
): Promise<ConditionsResponse | null> {
  const loc = getLocation(slug);
  if (!loc) return null;
  const [snapshot, cams] = await Promise.all([getSnapshot(slug), buildCamViews(loc)]);
  if (!snapshot) return null;
  return {
    snapshot,
    score: computeScore(snapshot),
    hourlyScores: computeHourlyScores(snapshot),
    cams,
  };
}
