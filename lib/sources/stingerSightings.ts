// ---------------------------------------------------------------------------
// Live Portuguese man-o'-war (Physalia physalis) sightings, via iNaturalist's
// public observations API. This is the "honesty upgrade" for lib/marineStinger.ts:
// sustained onshore wind alone is only weakly predictive of a stranding (the
// animals must already be offshore for wind to matter), so a recent, nearby,
// citizen-science-confirmed sighting turns "wind says possible" into "observed
// nearby" — and, just as informatively, a checked-and-empty feed turns "wind
// says possible" into "no corroborating reports, treat cautiously."
//
// This module is a NETWORK call and must never throw into the pipeline: any
// failure (timeout, non-200, malformed body, empty result) degrades to `null`,
// which lib/marineStinger.ts treats as "sightings feed unavailable" — a
// distinct, honestly-labeled state from "checked and found nothing" (empty
// `results`, count 0).
// ---------------------------------------------------------------------------

import { fetchWithTimeout, haversineMiles, round } from "@/lib/util";

const ATTRIBUTION = "iNaturalist (community-verified Physalia physalis observations)";

/** iNaturalist's taxon ID for Physalia physalis (Portuguese man o' war). */
const PHYSALIA_TAXON_ID = 117302;

const BASE_URL = "https://api.inaturalist.org/v1/observations";

const MI_TO_KM = 1.609344;

/** Default lower bound (days back) for the `d1` observed-date filter — wide
 *  enough to catch a slow-moving bloom's tail without pulling ancient reports
 *  that say nothing about "is one nearby right now". */
const DEFAULT_DAYS_BACK = 14;
/** Default search radius (km) — iNaturalist's `radius` param. 100 km comfortably
 *  covers "this stretch of coast", matching the ≤100 km gate marineStinger.ts
 *  applies when deciding whether a sighting counts as "nearby". */
const DEFAULT_RADIUS_KM = 100;
/** One page is plenty: we only need "is there recent activity nearby", not a
 *  census. iNaturalist returns newest-first (order_by=observed_on&order=desc),
 *  so the freshest reports are always inside this page even if the true total
 *  exceeds it. */
const DEFAULT_PER_PAGE = 50;

export interface StingerSightingsOptions {
  /** How many days back the `d1` observed-date lower bound reaches. Default 14. */
  daysBack?: number;
  /** Search radius in km. Default 100. */
  radiusKm?: number;
  /** Max observations to page in. Default 50. */
  perPage?: number;
  /** Fetch timeout, ms. Default 8000. */
  timeoutMs?: number;
  /** Injectable "now" for deterministic date-bound tests. Defaults to real time. */
  now?: Date;
}

export interface StingerSightings {
  /** Number of qualifying observations returned (bounded by `perPage` — this is
   *  "is there recent activity", not an exact census of the search window). */
  count: number;
  /** The most recent observation's `observed_on` date (YYYY-MM-DD local to the
   *  observer), if any observation carried a parseable date. */
  mostRecentIso?: string;
  /** Great-circle distance (km) from (lat, lon) to the NEAREST observation that
   *  published a location. Undefined if no returned observation had usable
   *  geojson (e.g. all geoprivacy-obscured) even though `count` may be > 0. */
  nearestKm?: number;
  /** The requested lower-bound window, in days — echoes `opts.daysBack` so a
   *  caller can judge "checked how far back" alongside the result. */
  withinDays: number;
}

interface INatObservationGeojson {
  type?: string;
  /** [lon, lat] per GeoJSON convention. */
  coordinates?: [number, number];
}

interface INatObservation {
  observed_on?: string | null;
  geojson?: INatObservationGeojson | null;
}

interface INatObservationsResponse {
  total_results?: number;
  results?: INatObservation[];
}

/** ISO YYYY-MM-DD for `n` days before `now` — iNaturalist's `d1` date filter
 *  wants a plain date, not a timestamp. */
function isoDateNDaysAgo(n: number, now: Date): string {
  return new Date(now.getTime() - n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Fetch recent nearby Physalia physalis observations from iNaturalist and
 * reduce them to the small honest shape lib/marineStinger.ts needs. Graceful
 * on every failure mode (timeout, non-2xx, malformed JSON, network error) —
 * returns `null` rather than throwing, since this is a best-effort cross-check
 * layered on top of a wind-only estimate, never a hard dependency.
 *
 * An EMPTY but successful response (`results: []`) is NOT `null` — it's a
 * genuinely informative "checked, nothing recent nearby" (`count: 0`), which
 * lib/marineStinger.ts uses to actively lower confidence rather than merely
 * falling back to "wind-only".
 */
export async function fetchStingerSightings(
  lat: number,
  lon: number,
  opts: StingerSightingsOptions = {},
): Promise<StingerSightings | null> {
  const daysBack = opts.daysBack ?? DEFAULT_DAYS_BACK;
  const radiusKm = opts.radiusKm ?? DEFAULT_RADIUS_KM;
  const perPage = opts.perPage ?? DEFAULT_PER_PAGE;
  const now = opts.now ?? new Date();
  const d1 = isoDateNDaysAgo(daysBack, now);

  const url =
    `${BASE_URL}?taxon_id=${PHYSALIA_TAXON_ID}&lat=${lat}&lng=${lon}` +
    `&radius=${radiusKm}&d1=${d1}&order=desc&order_by=observed_on&per_page=${perPage}`;

  try {
    const res = await fetchWithTimeout(url, {
      timeoutMs: opts.timeoutMs ?? 8000,
      // A descriptive contact UA — fetchWithTimeout already attaches the
      // project-wide default (isitbeachday.com contact, same one metno.ts and
      // every other source send); iNaturalist's API usage guidelines ask for
      // exactly this kind of identifiable UA, so no override is needed here.
      //
      // Sightings history barely moves minute-to-minute — a new stranding
      // report doesn't change the "onshore wind + recent nearby sighting"
      // read meaningfully within a few hours, and iNaturalist is a shared
      // public API that shouldn't be hammered on every page load. 6h keeps
      // the sightings gate honestly fresh across a tide cycle without
      // re-fetching constantly.
      next: { revalidate: 6 * 60 * 60 },
    });
    if (!res.ok) throw new Error(`iNaturalist observations -> ${res.status}`);

    const json = (await res.json()) as INatObservationsResponse;
    // A 200 body that lacks a `results` ARRAY is schema-invalid/malformed — NOT
    // a genuine "checked, nothing nearby". Treat it as unavailable (null) so the
    // caller stays "wind-only" rather than damping the man-o'-war read with a
    // fabricated `count: 0`. `count: 0` is reserved for a real EMPTY array.
    if (!Array.isArray(json?.results)) return null;
    const results = json.results;

    let mostRecentMs: number | undefined;
    let mostRecentIso: string | undefined;
    let nearestKm: number | undefined;

    for (const obs of results) {
      if (typeof obs?.observed_on === "string") {
        const t = Date.parse(obs.observed_on);
        if (Number.isFinite(t) && (mostRecentMs === undefined || t > mostRecentMs)) {
          mostRecentMs = t;
          mostRecentIso = obs.observed_on;
        }
      }
      const coords = obs?.geojson?.coordinates;
      if (Array.isArray(coords) && coords.length === 2) {
        const [obsLon, obsLat] = coords;
        if (typeof obsLat === "number" && typeof obsLon === "number") {
          const km = haversineMiles(lat, lon, obsLat, obsLon) * MI_TO_KM;
          if (Number.isFinite(km) && (nearestKm === undefined || km < nearestKm)) {
            nearestKm = km;
          }
        }
      }
    }

    return {
      count: results.length,
      mostRecentIso,
      nearestKm: nearestKm !== undefined ? round(nearestKm, 1) : undefined,
      withinDays: daysBack,
    };
  } catch {
    // Network failure, non-200, or a malformed body (res.json() throwing on
    // invalid JSON) all land here — fail-soft, never throw into the caller.
    return null;
  }
}

export { ATTRIBUTION as STINGER_SIGHTINGS_ATTRIBUTION };
