// Pure timezone resolution for the resolver. v1 deliberately adds NO tz-lookup
// dependency: the geocoder (Open-Meteo / GeoNames) already supplies the IANA
// timezone, so we simply trust it when present and degrade gracefully otherwise.

import type { Confidence, GeoPoint } from "@/lib/resolve/types";

/** A resolved timezone with a confidence rating. */
export interface ResolvedTimezone {
  /** IANA timezone, e.g. "America/New_York"; undefined when the geocode lacks one. */
  timezone?: string;
  confidence: Confidence;
}

/**
 * Resolve the IANA timezone for a geocoded point. Prefers `geo.timezone`
 * (confidence "high"). When absent, returns `{ timezone: undefined, confidence:
 * "low" }` — the resolver can flag it as an owner-TODO rather than guessing.
 */
export function resolveTimezone(geo: GeoPoint): ResolvedTimezone {
  if (geo.timezone) return { timezone: geo.timezone, confidence: "high" };
  return { timezone: undefined, confidence: "low" };
}
