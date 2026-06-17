// Surf-zone resolver: from a lat/lon (and optional place name) derive the NWS
// issuing office (WFO) and the Surf Zone Forecast (SRF) zone-block name that
// lib/sources/nws.ts parseRipRisk() can match.
//
// House style mirrors lib/sources/nws.ts: a pure core (pickSurfZoneName) split
// from thin async fetchers (resolveOffice / resolveSurfZone). Fetchers never
// throw — on error they return an empty/degraded value.

import type { Confidence } from "@/lib/resolve/types";
import { fetchWithTimeout } from "@/lib/util";

/** Descriptive User-Agent NWS asks for, matching the other api.weather.gov calls. */
const USER_AGENT =
  process.env.CONDITIONS_USER_AGENT ?? "isitbeachday.com (hello@isitbeachday.com)";

// --- pure core -------------------------------------------------------------

/** A parsed SRF zone block: its UGC zone ids and a cleaned header name. */
interface ZoneBlock {
  /** UGC zone ids found in the block header, e.g. ["FLZ168"]. */
  zoneIds: string[];
  /** Cleaned header line, e.g. "Coastal Palm Beach County". */
  name: string;
  /** The raw block text (for empty-block filtering). */
  raw: string;
}

/** Normalize a zone id for comparison, e.g. " flz168 " -> "FLZ168". */
function normZoneId(id: string): string {
  return id.trim().toUpperCase();
}

/**
 * Parse one `$$`-delimited SRF block into its zone ids + a human header.
 *
 * A block looks like:
 *   FLZ168-152100-
 *   Coastal Palm Beach County-
 *   400 AM EDT Sun Jun 15 2026
 *   .TODAY... ...
 *
 * The first line(s) carry one or more UGC zone ids (e.g. `FLZ168-152100-`,
 * sometimes a hyphen-joined list like `FLZ168-172-152100-`). The descriptive
 * header is the first alphabetic line *after* the UGC line — this skips any
 * product preamble (000 / WMO id / product title) that precedes the first zone.
 */
function parseBlock(raw: string): ZoneBlock | null {
  const lines = raw.split(/\r?\n/).map((l) => l.trim());
  const zoneIds: string[] = [];
  let name = "";
  let seenUgc = false;

  for (const line of lines) {
    if (!line) continue;
    // A UGC code line: starts with a 3-letter+Z/C zone id, e.g. FLZ168 / FLC011.
    // May be a hyphen-joined list (FLZ168-172-152100-) ending in a time group.
    const ugc = line.match(/\b([A-Z]{2}[ZC]\d{3})\b/g);
    if (ugc && /^[A-Z0-9-]+$/.test(line)) {
      for (const id of ugc) zoneIds.push(normZoneId(id));
      seenUgc = true;
      continue;
    }
    // The header is the first alphabetic line after the UGC code(s). Lines
    // before any UGC are product preamble (000, WMO id, title) and are skipped.
    if (seenUgc && !name && /[A-Za-z]/.test(line)) {
      name = line.replace(/-+\s*$/, "").trim();
    }
  }

  if (!name && zoneIds.length === 0) return null;
  return { zoneIds, name, raw };
}

/**
 * Pick the SRF zone-block name for a surf forecast. PURE — no network.
 *
 * Strategy (highest confidence first):
 *   1. zone-id match against `opts.forecastZone` (UGC id) -> "high"
 *   2. place-name match against `opts.place` (county/place token) -> "medium"
 *   3. ambiguous: prefer a "Coastal ..." header (the surf twin of an inland
 *      public zone) -> "low" + note (caller warns SURF_ZONE_UNCERTAIN)
 *
 * The returned `name` is the cleaned header string, chosen so that
 * lib/sources/nws.ts parseRipRisk(srfText, name) selects the same block.
 */
export function pickSurfZoneName(
  srfText: string,
  opts: { place?: string; forecastZone?: string },
): { name?: string; confidence: Confidence; note?: string } {
  const blocks = srfText
    .split("$$")
    .map(parseBlock)
    .filter((b): b is ZoneBlock => b !== null && (b.name.length > 0 || b.zoneIds.length > 0));

  if (blocks.length === 0) {
    return { confidence: "low", note: "SRF product had no parseable zone blocks" };
  }

  // 1) Exact UGC zone-id match -> high confidence.
  const wantId = opts.forecastZone ? normZoneId(opts.forecastZone) : undefined;
  if (wantId) {
    const hit = blocks.find((b) => b.zoneIds.includes(wantId));
    if (hit && hit.name) {
      return { name: hit.name, confidence: "high" };
    }
  }

  // 2) Place-name match -> medium confidence. Match on the distinctive place
  // token (e.g. "Palm Beach") rather than the whole string, and prefer the
  // coastal twin when both an inland and a coastal block share the place.
  const place = opts.place?.trim();
  if (place) {
    const placeRe = new RegExp(
      place.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "i",
    );
    const named = blocks.filter((b) => b.name);
    const matches = named.filter((b) => placeRe.test(b.name));
    if (matches.length === 1) {
      return { name: matches[0].name, confidence: "medium" };
    }
    if (matches.length > 1) {
      const coastal = matches.find((b) => /^coastal\b/i.test(b.name));
      const chosen = coastal ?? matches[0];
      return {
        name: chosen.name,
        confidence: "medium",
        note: coastal
          ? undefined
          : "Multiple blocks matched the place name; picked the first",
      };
    }
  }

  // 3) Ambiguous. Prefer a "Coastal ..." block (the surf zone is the coastal
  // twin of the inland public zone the city centroid often resolves to).
  const named = blocks.filter((b) => b.name);
  const coastal = named.find((b) => /^coastal\b/i.test(b.name));
  if (coastal) {
    return {
      name: coastal.name,
      confidence: "low",
      note: "No zone-id or place match; fell back to first Coastal block",
    };
  }

  const first = named[0];
  return {
    name: first?.name,
    confidence: "low",
    note: "No zone-id or place match; fell back to first zone block",
  };
}

// --- fetch -----------------------------------------------------------------

interface PointsJson {
  properties?: {
    cwa?: string;
    forecastZone?: string;
  };
}

/** Extract the trailing UGC id from a forecastZone URL, e.g. ".../FLZ168" -> "FLZ168". */
function zoneIdFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const m = url.match(/([A-Z]{2}[ZC]\d{3})\s*$/i);
  return m ? normZoneId(m[1]) : undefined;
}

/**
 * Look up the NWS issuing office (WFO) and forecast-zone id for a point.
 * Returns `{}` on any error (sources never throw).
 */
export async function resolveOffice(
  lat: number,
  lon: number,
): Promise<{ office?: string; forecastZone?: string }> {
  try {
    const res = await fetchWithTimeout(
      `https://api.weather.gov/points/${lat},${lon}`,
      {
        timeoutMs: 7000,
        headers: { "User-Agent": USER_AGENT },
        next: { revalidate: 86400 }, // points->office mapping is stable
      },
    );
    if (!res.ok) return {};
    const json = (await res.json()) as PointsJson;
    const office = json.properties?.cwa?.trim() || undefined;
    const forecastZone = zoneIdFromUrl(json.properties?.forecastZone);
    return { office, forecastZone };
  } catch {
    return {};
  }
}

interface ProductsListJson {
  "@graph"?: { id?: string }[];
}

interface ProductJson {
  productText?: string;
}

/**
 * Resolve the surf-zone office + zone-block name for a point. Office is taken
 * from the NWS points endpoint (high confidence). The name is derived from the
 * office's latest SRF product via pickSurfZoneName (may be medium/low).
 *
 * Never throws. On error returns `{ office }` (if known) with name undefined
 * and confidence "low".
 */
export async function resolveSurfZone(
  lat: number,
  lon: number,
  place?: string,
): Promise<{ office?: string; name?: string; confidence: Confidence; note?: string }> {
  const { office, forecastZone } = await resolveOffice(lat, lon);
  if (!office) {
    return { confidence: "low", note: "Could not resolve NWS office for point" };
  }

  try {
    const list = await fetchWithTimeout(
      `https://api.weather.gov/products/types/SRF/locations/${office}`,
      {
        timeoutMs: 7000,
        headers: { "User-Agent": USER_AGENT },
        next: { revalidate: 3600 },
      },
    );
    if (!list.ok) {
      return { office, confidence: "low", note: `SRF list -> ${list.status}` };
    }
    const graph = ((await list.json()) as ProductsListJson)["@graph"] ?? [];
    const id = graph[0]?.id;
    if (!id) {
      return { office, confidence: "low", note: "No SRF product for office" };
    }
    const prod = await fetchWithTimeout(
      `https://api.weather.gov/products/${id}`,
      {
        timeoutMs: 7000,
        headers: { "User-Agent": USER_AGENT },
        next: { revalidate: 3600 },
      },
    );
    if (!prod.ok) {
      return { office, confidence: "low", note: `SRF product -> ${prod.status}` };
    }
    const text = ((await prod.json()) as ProductJson).productText ?? "";
    const picked = pickSurfZoneName(text, { place, forecastZone });
    return { office, ...picked };
  } catch (e) {
    return { office, confidence: "low", note: String(e) };
  }
}
