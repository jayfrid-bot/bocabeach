// Open-Meteo geocoding adapter for the location resolver. Keyless, free:
//   https://geocoding-api.open-meteo.com/v1/search?name=<q>&count=5&country_code=US
//
// House style mirrors lib/sources/*: a pure parser (parseGeocode) split from a
// thin async fetcher (geocodeName). The fetcher never throws — on any error it
// returns an empty list, the typed "no results" value for a geocoder.

import { fetchWithTimeout } from "@/lib/util";
import type { GeoPoint } from "./types";

const USER_AGENT = "isitbeachday.com (hello@isitbeachday.com)";

/** USPS two-letter codes keyed by Open-Meteo's `admin1` state display name. */
const STATE_ABBR: Record<string, string> = {
  Alabama: "AL",
  Alaska: "AK",
  Arizona: "AZ",
  Arkansas: "AR",
  California: "CA",
  Colorado: "CO",
  Connecticut: "CT",
  Delaware: "DE",
  "District of Columbia": "DC",
  Florida: "FL",
  Georgia: "GA",
  Hawaii: "HI",
  Idaho: "ID",
  Illinois: "IL",
  Indiana: "IN",
  Iowa: "IA",
  Kansas: "KS",
  Kentucky: "KY",
  Louisiana: "LA",
  Maine: "ME",
  Maryland: "MD",
  Massachusetts: "MA",
  Michigan: "MI",
  Minnesota: "MN",
  Mississippi: "MS",
  Missouri: "MO",
  Montana: "MT",
  Nebraska: "NE",
  Nevada: "NV",
  "New Hampshire": "NH",
  "New Jersey": "NJ",
  "New Mexico": "NM",
  "New York": "NY",
  "North Carolina": "NC",
  "North Dakota": "ND",
  Ohio: "OH",
  Oklahoma: "OK",
  Oregon: "OR",
  Pennsylvania: "PA",
  "Rhode Island": "RI",
  "South Carolina": "SC",
  "South Dakota": "SD",
  Tennessee: "TN",
  Texas: "TX",
  Utah: "UT",
  Vermont: "VT",
  Virginia: "VA",
  Washington: "WA",
  "West Virginia": "WV",
  Wisconsin: "WI",
  Wyoming: "WY",
  // US territories that appear in Open-Meteo results with country_code "US".
  "Puerto Rico": "PR",
  "U.S. Virgin Islands": "VI",
  Guam: "GU",
  "American Samoa": "AS",
  "Northern Mariana Islands": "MP",
};

/** Shape of a single Open-Meteo geocoding result. All fields optional/defensive. */
interface OpenMeteoResult {
  name?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  admin1?: unknown;
  admin2?: unknown;
  country_code?: unknown;
  timezone?: unknown;
  population?: unknown;
  feature_code?: unknown;
}

interface OpenMeteoResponse {
  results?: unknown;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Map an Open-Meteo geocoding response to GeoPoint[]. Pure and defensive against
 * missing/mistyped fields. `admin1Code` is derived from the `admin1` state name
 * via STATE_ABBR; `kind` is "city" when feature_code starts with "PPL" else
 * "place". Filtered to US results only (countryCode === "US").
 */
export function parseGeocode(json: unknown): GeoPoint[] {
  const results = (json as OpenMeteoResponse | null | undefined)?.results;
  if (!Array.isArray(results)) return [];

  const out: GeoPoint[] = [];
  for (const raw of results as OpenMeteoResult[]) {
    if (!raw || typeof raw !== "object") continue;
    if (!isNum(raw.latitude) || !isNum(raw.longitude)) continue;

    const countryCode = asStr(raw.country_code);
    if (countryCode !== "US") continue; // US-only resolver

    const admin1 = asStr(raw.admin1);
    const featureCode = asStr(raw.feature_code);

    const point: GeoPoint = {
      name: asStr(raw.name) ?? "",
      lat: raw.latitude,
      lon: raw.longitude,
      countryCode,
      kind: featureCode?.startsWith("PPL") ? "city" : "place",
    };
    if (admin1 !== undefined) point.admin1 = admin1;
    const admin2 = asStr(raw.admin2);
    if (admin2 !== undefined) point.admin2 = admin2;
    const code = admin1 ? STATE_ABBR[admin1] : undefined;
    if (code) point.admin1Code = code;
    const tz = asStr(raw.timezone);
    if (tz !== undefined) point.timezone = tz;
    if (isNum(raw.population)) point.population = raw.population;
    if (featureCode !== undefined) point.featureCode = featureCode;

    out.push(point);
  }
  return out;
}

/**
 * Geocode a free-text place query via Open-Meteo (keyless). Returns US GeoPoints,
 * or [] on any error/non-OK response — the geocoder never throws.
 */
export async function geocodeName(query: string, count = 5): Promise<GeoPoint[]> {
  try {
    const url =
      `https://geocoding-api.open-meteo.com/v1/search` +
      `?name=${encodeURIComponent(query)}&count=${count}&country_code=US`;
    const res = await fetchWithTimeout(url, {
      timeoutMs: 7000,
      headers: { "User-Agent": process.env.CONDITIONS_USER_AGENT ?? USER_AGENT },
      next: { revalidate: 86400 }, // 1d — place coordinates are effectively static
    });
    if (!res.ok) return [];
    return parseGeocode(await res.json());
  } catch {
    return [];
  }
}
