import { getLocation, toPublicLocation } from "@/config/locations";
import type { ConditionsResponse, ConditionsSnapshot } from "@/lib/types";
import { fetchBuoy } from "@/lib/sources/buoy";
import { fetchCityOfficial } from "@/lib/sources/cityOfficial";
import { fetchMarine } from "@/lib/sources/marine";
import { fetchTides } from "@/lib/sources/tides";
import { fetchWaterQuality } from "@/lib/sources/waterQuality";
import { fetchWeather } from "@/lib/sources/weather";
import { computeScores } from "@/lib/score";
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

  const [tides, buoy, weather, marine, cityOfficial, waterQuality] =
    await Promise.all([
      fetchTides(loc),
      fetchBuoy(loc),
      fetchWeather(loc),
      fetchMarine(loc),
      fetchCityOfficial(loc),
      fetchWaterQuality(loc),
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
  };
}

export async function getConditions(
  slug: string,
): Promise<ConditionsResponse | null> {
  const loc = getLocation(slug);
  if (!loc) return null;
  const snapshot = await getSnapshot(slug);
  if (!snapshot) return null;
  return { snapshot, scores: computeScores(snapshot, loc) };
}
