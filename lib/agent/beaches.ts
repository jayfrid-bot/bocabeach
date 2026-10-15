// The beach directory as agents see it: summaries, filters and nearest-by-shore.
// Reads the same list the website serves (config/locations.ts, including beaches
// the owner added from the admin console), so there is no second list to drift.

import { listLocations, toPublicLocation } from "@/config/locations";
import { rankBeaches } from "@/lib/location/nearest";
import { degToCardinal } from "@/lib/util";
import { SITE_URL } from "@/lib/agent/constants";

export interface BeachSummary {
  slug: string;
  name: string;
  /** Free text from the config, e.g. "Palm Beach County, FL". */
  region: string;
  /** Two-letter US state code, or null when the region text has none. */
  state: string | null;
  lat: number;
  lon: number;
  /** The beach's page on isitbeachday.com. */
  url: string;
}

export interface NearbyBeach extends BeachSummary {
  distanceMiles: number;
  distanceKm: number;
  /** Compass bearing from the point you gave to the nearest sand (0 = north). */
  bearingDeg: number;
  /** The same bearing as a compass word, e.g. "NE". */
  direction: string;
}

export function stateOf(region: string): string | null {
  const m = /,\s*([A-Z]{2})\s*$/.exec(region);
  return m ? m[1] : null;
}

/** The page URL. The flagship beach lives at "/" (its /<slug> redirects there). */
export function beachUrl(slug: string): string {
  const all = listLocations();
  const flagship = all.find((l) => l.tier !== "auto") ?? all[0];
  return flagship && flagship.slug === slug ? `${SITE_URL}/` : `${SITE_URL}/${slug}`;
}

export function listBeachSummaries(): BeachSummary[] {
  return listLocations().map((l) => ({
    slug: l.slug,
    name: l.name,
    region: l.region,
    state: stateOf(l.region),
    lat: l.lat,
    lon: l.lon,
    url: beachUrl(l.slug),
  }));
}

export function findBeach(slug: string): BeachSummary | undefined {
  return listBeachSummaries().find((b) => b.slug === slug);
}

const STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID",
  illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "district of columbia": "DC",
};
const STATE_CODES = new Set(Object.values(STATES));

/** "FL" or "florida" -> "FL"; anything else -> null. */
export function normalizeState(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const up = t.toUpperCase();
  if (STATE_CODES.has(up)) return up;
  return STATES[t.toLowerCase().replace(/\s+/g, " ")] ?? null;
}

export interface BeachFilter {
  /** Normalized two-letter code. */
  state?: string;
  /** Case-insensitive text found in the beach's region or name, e.g. "Broward". */
  region?: string;
}

export function filterBeaches(beaches: readonly BeachSummary[], f: BeachFilter): BeachSummary[] {
  const region = f.region?.trim().toLowerCase();
  return beaches.filter(
    (b) =>
      (!f.state || b.state === f.state) &&
      (!region || b.region.toLowerCase().includes(region) || b.name.toLowerCase().includes(region)),
  );
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const KM_PER_MILE = 1.609344;

/** Beaches nearest-first, measured to the closest point on each shoreline. */
export function nearestBeaches(
  lat: number,
  lon: number,
  limit: number,
  pool: readonly BeachSummary[] = listBeachSummaries(),
): NearbyBeach[] {
  const bySlug = new Map(pool.map((b) => [b.slug, b]));
  const publics = listLocations()
    .filter((l) => bySlug.has(l.slug))
    .map(toPublicLocation);
  return rankBeaches(lat, lon, publics)
    .slice(0, Math.max(0, limit))
    .map((r) => {
      const summary = bySlug.get(r.beach.slug)!;
      const bearing = Math.round(r.bearingDeg);
      return {
        ...summary,
        distanceMiles: round1(r.distanceMi),
        distanceKm: round1(r.distanceMi * KM_PER_MILE),
        bearingDeg: bearing % 360,
        direction: degToCardinal(bearing),
      };
    });
}
