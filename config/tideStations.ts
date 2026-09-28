// Per-beach NOAA CO-OPS station mapping for the "king tide" / high-tide-
// flooding feed (scripts/king_tide.mjs, published by
// .github/workflows/king-tide.yml to its own `king-tide-data` branch, read
// by lib/sources/kingTide.ts). See docs/SKY_EVENTS_PLAN.md §3 and §13 Crew D.
//
// Each of the 39 beaches (config/locations.ts's 3 hand-curated entries +
// config/locations.generated.json's 36 auto-added ones) maps to exactly ONE
// NOAA station used for BOTH the tide predictions AND (when it publishes
// one) the flood threshold — "always the same station so datum never
// mixes" (§3). For most beaches that's simply their own `noaaTideStationId`
// from config/locations.ts. A handful borrow a NEARBY station instead
// (`noaaTideStationFallbackId` or another station entirely) when, and only
// when, a human confirmed it's close enough and geographically comparable
// to be trusted for a flood-threshold comparison — see each entry's comment.
//
// `representative` is the hand-reviewed flag from §3: true ONLY when a
// human confirmed (a) the station publishes a real flood threshold
// (`nws_minor`, or `nos_minor` when NWS is null, at
// https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/<id>/floodlevels.json)
// and (b) the station is geographically representative of the beach (same
// town/inlet, <= ~10 mi, open-coast vs open-coast — never approved from
// proximity alone). Only a `representative: true` station's crossings reach
// the alert-eligible "validated" tier (§3 tier 1); every beach still gets
// the card-only "very-high" percentile tier from its own station's
// predictions regardless of this flag.
//
// `thresholdDatum` is the SEPARATE, also-hand-verified fact of which datum
// that published threshold is actually expressed in — "STND" for every
// `representative: true` entry below (verified live: each one's own
// `datum=STND` predictions sit on the exact same scale as its
// floodlevels.json numbers), `null` everywhere else. This is NOT redundant
// with `representative`: a representative station's predictions can still
// fail at STND on any GIVEN run (e.g. a transient NOAA hiccup) and fall back
// to MLLW (scripts/king_tide.mjs's datum fallback) — when that happens, the
// script must compare `thresholdDatum` against THAT RUN's actual fetched
// datum before ever using the threshold, never assume "representative:true
// implies STND succeeded this time." A temporary STND failure must never
// let an MLLW-scale prediction get compared against an STND-scale
// threshold — see scripts/king_tide.mjs's `canUseThreshold` and
// lib/sources/kingTide.ts's matching defense-in-depth re-check.
//
// Live-checked against every station below (and every beach's
// `noaaTideStationFallbackId`, as a candidate borrow) on 2026-09-28. Coverage
// facts and thresholds change over time — re-verify before flipping a flag.

export interface TideStationMapping {
  /** NOAA CO-OPS station id used for both predictions and (if it has one)
   *  the flood threshold. Usually the beach's own `noaaTideStationId`; see
   *  the entry's comment for the few borrowed exceptions. */
  stationId: string;
  /** Hand-reviewed per §3 — see file header. Default false. */
  representative: boolean;
  /** The datum this station's OWN published flood threshold is expressed
   *  in — hand-verified, "STND" for every `representative: true` entry
   *  today, `null` for every other entry (no threshold to compare against,
   *  so no datum claim to make). See file header: this must be checked
   *  against each RUN's actual fetched prediction datum, not just trusted
   *  because `representative` is true. */
  thresholdDatum: "STND" | null;
}

export const TIDE_STATIONS: Record<string, TideStationMapping> = {
  // --- Hand-curated beaches (config/locations.ts) ---------------------------

  "boca-raton": {
    stationId: "8722816", // Boca Raton (own primary; subordinate, predictions only)
    representative: false,
    thresholdDatum: null,
    // 8722816 has no floodlevels.json (404, checked 2026-09-28). The app's
    // documented OBSERVED-water-level fallback, Lake Worth Pier 8722670, DOES
    // publish one (nws_minor 34.35, STND) but sits 17.7 mi north (haversine,
    // beach pin to station) — past this file's ~10 mi bar, so it's
    // deliberately NOT borrowed here. Very-high tier only (own station).
  },
  "deerfield-beach": {
    stationId: "8722832", // Deerfield Beach, Hillsboro River (own primary; subordinate)
    representative: false,
    thresholdDatum: null,
    // 8722832 has no floodlevels.json (404). The app's documented OBSERVED
    // fallback, South Port Everglades 8722956, DOES publish one (nws_minor
    // 28.18, STND) but sits 16.4 mi south of Deerfield — past the ~10 mi bar.
    // (Compare fort-lauderdale below, which borrows this SAME station at
    // 2.7 mi — the bar is per-beach distance, not per-station.)
  },
  "fort-lauderdale": {
    stationId: "8722956", // BORROWED: South Port Everglades, ICWW (own primary 8722939 has none)
    representative: true,
    thresholdDatum: "STND",
    // 8722939 (Bahia Mar, own primary) has no floodlevels.json (404). South
    // Port Everglades 8722956 is only 2.7 mi south, at the SAME Port
    // Everglades inlet that opens directly onto Fort Lauderdale's beach — and
    // is already the app's own documented OBSERVED-water-level gauge for this
    // beach (lib/sources/tides.ts / config/locations.ts). Publishes nws_minor
    // 28.18 (STND, verified against a live STND predictions fetch: ~27.4-
    // 27.6 ft same day, same scale). Close enough, same inlet, existing
    // precedent -> representative.
  },

  // --- Auto-added beaches (config/locations.generated.json) -----------------

  "gulf-shores": {
    stationId: "8731269", // Gulf Shores (own primary)
    representative: false, // no floodlevels.json (404); fallback 8731439 also 404.
    thresholdDatum: null,
  },
  "cocoa-beach": {
    stationId: "8721649", // Cocoa Beach (own primary)
    representative: false, // no floodlevels.json (404); fallback 8721727 also 404.
    thresholdDatum: null,
  },
  "south-padre-island": {
    stationId: "8779749", // BORROWED: Brazos Santiago Pass (own primary 8779768 has none)
    representative: true,
    thresholdDatum: "STND",
    // 8779768 (own primary) has no floodlevels.json (404). Brazos Santiago
    // Pass 8779749 is 2.65 mi away, the tidal inlet at the island's own south
    // tip connecting the Gulf straight through to the beach's own waters.
    // Publishes nws_minor 26.97 (STND, verified: live STND highs ~25.7-26.2
    // ft same day, same scale). Same inlet, close -> representative.
  },
  "cape-may": {
    stationId: "8535901", // Cape May (own primary)
    representative: false, // no floodlevels.json (404); fallback 8535805 also 404.
    thresholdDatum: null,
  },
  "folly-beach": {
    stationId: "8666467", // Folly Beach (own primary)
    representative: false, // no floodlevels.json (404); fallback is TEC3127 (subordinate, not checked — non-numeric CO-OPS mdapi lookups 404 for every TEC/TWC id tried elsewhere in this file).
    thresholdDatum: null,
  },
  "tybee-island": {
    stationId: "TEC3399", // Tybee Creek entrance (own primary; type "S" subordinate)
    representative: false,
    thresholdDatum: null,
    // No floodlevels.json for TEC3399 or fallback 8670892 (both 404). TEC3399
    // also doesn't support datum=STND for predictions (confirmed live: STND
    // errors "No Predictions data was found", MLLW succeeds) — the adapter's
    // script falls back to MLLW for this station; moot for the threshold
    // tier since there is no threshold, but it means `datum` in the
    // published feed for this station reads "MLLW", not "STND".
  },
  "cannon-beach": {
    stationId: "9437954", // Cannon Beach (own primary)
    representative: false, // no floodlevels.json (404); fallback 9437908 also 404.
    thresholdDatum: null,
  },
  "naples": {
    stationId: "8725114", // Naples (own primary)
    representative: true,
    thresholdDatum: "STND",
    // nws_minor 6.12 (STND, matches plan's live check and this pass's:
    // STND highs ~5.0 ft same day, same scale).
  },
  "nags-head": {
    stationId: "8652587", // Nags Head/Oregon Inlet Marina (own primary)
    representative: true,
    thresholdDatum: "STND",
    // nws_minor 5.58 (STND highs ~3.8-4.0 ft same day, same scale).
  },
  "jacksonville-beach": {
    stationId: "8720214", // Jacksonville Beach (own primary)
    representative: false, // no floodlevels.json (404); fallback 8720211 also 404.
    thresholdDatum: null,
  },
  "galveston": {
    stationId: "8771450", // Galveston Pier 21 (own primary)
    representative: true,
    thresholdDatum: "STND",
    // nws_minor 8.38 (STND highs ~6.0 ft same day, same scale).
  },
  "ocean-shores": {
    stationId: "9441102", // BORROWED: Westport, Point Chehalis (own primary 9441156 has none)
    representative: true,
    thresholdDatum: "STND",
    // 9441156 (own primary) has no floodlevels.json (404). Point Chehalis
    // 9441102 is 5.4 mi away, on the OPPOSITE jetty of the very same Grays
    // Harbor entrance Ocean Shores' own jetty sits on — both directly exposed
    // to the open Pacific at the same inlet mouth. Publishes nws_minor 13.94
    // (STND, verified: live STND highs ~11.4-12.7 ft same day, same scale).
  },
  "biloxi": {
    stationId: "8744117", // Biloxi (own primary)
    representative: false, // no floodlevels.json (404); fallback 8743735 also 404.
    thresholdDatum: null,
  },
  "waikiki": {
    stationId: "1612340", // Honolulu (own primary)
    representative: true,
    thresholdDatum: "STND",
    // nws_minor 6.41 (STND highs ~5.3-5.9 ft same day, same scale).
  },
  "myrtle-beach": {
    stationId: "8661070", // Springmaid Pier (own primary)
    representative: true,
    thresholdDatum: "STND",
    // nws_minor 36.29 (STND highs ~35.1-35.7 ft same day, same scale).
  },
  "grand-isle": {
    stationId: "TEC4455", // Bayou Rigaud, Grand Isle (own primary; type "S" subordinate)
    representative: false,
    thresholdDatum: null,
    // TEC4455 has no floodlevels.json (404). Its own reference station,
    // East Point 8761724 (2.6 mi away — TEC4455 is computed as an offset
    // FROM 8761724), DOES publish one (nos_minor 8.82) — but both stations
    // sit on Grand Isle's back-bay/harbor side (Bayou Rigaud / East Point),
    // not the open-Gulf beach side, so a flood threshold there isn't trusted
    // as representative of the swimming beach without independent
    // confirmation (§3's "open-coast vs open-coast" bar) — not borrowed.
    // TEC4455 also doesn't support datum=STND (confirmed live: errors;
    // MLLW succeeds) — the script falls back to MLLW for this station's
    // very-high tier, so its published `datum` reads "MLLW".
  },
  "coney-island": {
    stationId: "8517741", // Coney Island (own primary)
    representative: false, // no floodlevels.json (404); fallback 8517811 also 404.
    thresholdDatum: null,
  },
  "crescent-bay-park": {
    stationId: "9410840", // Santa Monica (own primary — shared with santa-monica below)
    representative: true,
    thresholdDatum: "STND",
    // nws_minor 9.47 (STND highs ~7.3-8.5 ft same day, same scale).
  },
  "long-beach": {
    stationId: "9410660", // BORROWED: Los Angeles (Outer Harbor) (own primary 9410650 has none)
    representative: true,
    thresholdDatum: "STND",
    // 9410650 (own primary) has no floodlevels.json (404). LA Outer Harbor
    // 9410660 is 0.96 mi away — inside the same San Pedro Bay breakwater
    // system Long Beach's own public beach itself sits in (this beach is
    // already a breakwater-sheltered bay beach, not an open-swell coast, so
    // the "outer harbor" station is a close match, not a mismatch). nws_minor
    // 10.82 / nos_minor 11.18 (STND, verified: live STND highs ~8.7-10.0 ft
    // same day, same scale).
  },
  "santa-monica": {
    stationId: "9410840", // Santa Monica (own primary — shared with crescent-bay-park above)
    representative: true,
    thresholdDatum: "STND",
    // Same station/threshold as crescent-bay-park; see that entry.
  },
  "miami-beach": {
    stationId: "8723214", // Miami Beach, Government Cut (own primary)
    representative: true,
    thresholdDatum: "STND",
    // nws_minor 13.66 (STND highs ~12.9-13.0 ft same day, same scale) — the
    // exact pairing docs/SKY_EVENTS_PLAN.md §3 verified live.
  },
  "hammonasset-beach": {
    stationId: "8463701", // New London (own primary)
    representative: false, // no floodlevels.json (404); fallback 8464041 also 404.
    thresholdDatum: null,
  },
  "asbury-park": {
    stationId: "8532339", // Asbury Park (own primary)
    representative: false, // no floodlevels.json (404); fallback 8532371 also 404.
    thresholdDatum: null,
  },
  "seaside": {
    stationId: "9413450", // Monterey, Monterey Bay (own primary)
    representative: true,
    thresholdDatum: "STND",
    // nws_minor is null but nos_minor is 8.39 -> 10.57 (STND highs ~7.9-9.1
    // ft same day, same scale) — the spec's own fallback rule (§3: "nws_minor
    // (fallback nos_minor if NWS is null)") makes this station usable even
    // though it didn't show up in the plan's "return a real nws_minor" sweep.
  },
  "wrightsville-beach": {
    stationId: "8658163", // Wrightsville Beach (own primary)
    representative: true,
    thresholdDatum: "STND",
    // nws_minor 25.01 (STND highs ~23.6-24.2 ft same day, same scale).
  },
  "huntington-beach": {
    stationId: "9410599", // Huntington Beach (own primary)
    representative: false, // no floodlevels.json (404); fallback is TWC0427 (subordinate, not checked).
    thresholdDatum: null,
  },
  "hampton-beach": {
    stationId: "8429489", // Hampton Harbor (own primary)
    representative: false, // no floodlevels.json (404); fallback 8440452 also 404.
    thresholdDatum: null,
  },
  "la-jolla": {
    stationId: "9410230", // La Jolla (own primary)
    representative: true,
    thresholdDatum: "STND",
    // nws_minor 11.39 (STND highs ~9.1-10.4 ft same day, same scale).
  },
  "pismo-beach": {
    stationId: "9412110", // Port San Luis (own primary)
    representative: true,
    thresholdDatum: "STND",
    // nws_minor 11.28 (STND highs ~8.9-10.1 ft same day, same scale).
  },
  "santa-cruz": {
    stationId: "9413745", // Santa Cruz (own primary)
    representative: false, // no floodlevels.json (404); fallback is TWC0473 (subordinate, not checked).
    thresholdDatum: null,
  },
  "montauk": {
    stationId: "8510560", // Montauk (own primary)
    representative: true,
    thresholdDatum: "STND",
    // nws_minor 8.39 (STND highs ~6.2-6.8 ft same day, same scale).
  },
  "rehoboth-beach": {
    stationId: "8557863", // Rehoboth Beach (own primary)
    representative: false,
    thresholdDatum: null,
    // 8557863 has no floodlevels.json (404). Fallback Lewes (Breakwater
    // Harbor) 8557380 is only 5.1 mi away and does publish one (nws_minor
    // 8.78) — but it's inside the Delaware Breakwater at the mouth of
    // Delaware Bay, a sheltered bay/harbor gauge, while Rehoboth Beach is an
    // open Atlantic-facing beach a few miles south; not borrowed (same
    // open-coast-vs-bay reasoning as grand-isle above).
  },
  "virginia-beach": {
    stationId: "8639168", // Virginia Beach (own primary)
    representative: false, // no floodlevels.json (404); fallback 8639207 also 404.
    thresholdDatum: null,
  },
  "daytona-beach": {
    stationId: "8720954", // Daytona Beach Shores (own primary)
    representative: false, // no floodlevels.json (404); fallback 8721120 also 404.
    thresholdDatum: null,
  },
  "misquamicut": {
    stationId: "8458694", // Watch Hill, RI (own primary)
    representative: false, // no floodlevels.json (404); fallback 8458022 also 404.
    thresholdDatum: null,
  },
  "old-orchard-beach": {
    stationId: "8418557", // Old Orchard Beach (own primary)
    representative: false, // no floodlevels.json (404); fallback 8418445 also 404.
    thresholdDatum: null,
  },
};
