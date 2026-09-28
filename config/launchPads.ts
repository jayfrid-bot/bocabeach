// Stable LL2 (Launch Library 2, thespacedevs.com) location + pad IDs for the
// 4 launch ranges the "Coming up" sky-events card covers (SKY_EVENTS_PLAN.md
// §7, §13 Crew C): Cape Canaveral/KSC, Vandenberg, Wallops, Starbase.
//
// Every id below is a real LL2 `location.id` or `pad.id`, matched by ID —
// never parsed or inferred from a name string, per §7's explicit rule ("a
// range's launches are never missed or double-counted from a name-format
// change"). Verified LIVE against the LL2 2.3.0 API 2026-09-28:
//
//   curl "https://ll.thespacedevs.com/2.3.0/locations/?limit=100"
//     -> 143 SpaceX Starbase, TX, USA
//        11  Vandenberg SFB, CA, USA
//        27  Kennedy Space Center, FL, USA
//        12  Cape Canaveral SFS, FL, USA
//        21  Wallops Flight Facility, Virginia, USA
//
//   curl "https://ll.thespacedevs.com/2.3.0/pads/?limit=100&ordering=id"
//     (+ offset=100, offset=200 for full deterministic coverage — the
//     endpoint's DEFAULT ordering is not stable across requests, and a
//     `location__ids`/`location_ids` query filter was tried and silently
//     ignored by the server, confirmed by an unchanged result `count` —
//     so every pad below was found by fetching the FULL, `ordering=id`
//     pad list and filtering client-side by `location.id`, not by trusting
//     an unverified server-side filter)
//     -> every entry in LAUNCH_PADS below, each pad's own `id`/`latitude`/
//        `longitude`/`location.id` copied verbatim from that response.
//
// scripts/launch_library.mjs (plain Node, no TS build step — same
// convention scripts/rip_nwps.mjs uses for config/nwpsRip.ts) regex-parses
// THIS file's `locationIds: [...]` arrays at runtime rather than
// duplicating the id list by hand, so there is exactly one source of truth
// for "which LL2 location ids count as one of our 4 ranges." Keep every
// `locationIds` array written as a literal `[n, n, ...]` on one line (the
// parser's contract) if you edit this file.

export type LaunchRangeKey = "cape-canaveral" | "vandenberg" | "wallops" | "starbase";

export interface LaunchRange {
  key: LaunchRangeKey;
  name: string;
  /** LL2 `location.id` values that belong to this range. A launch's
   *  `pad.location.id` matching ANY id here puts it in range for §7's
   *  eligibility tiers, regardless of which individual pad it uses. */
  locationIds: readonly number[];
  /** Fallback pad coordinate for this range, used only when a launch's
   *  `pad.id` isn't individually listed in LAUNCH_PADS below (a new or
   *  decommissioned pad LL2 has added since this file was last reviewed) —
   *  approximate, but never blocks a launch from being shown just because
   *  its specific pad isn't catalogued yet. */
  fallbackLat: number;
  fallbackLon: number;
}

export const LAUNCH_RANGES: readonly LaunchRange[] = [
  {
    key: "cape-canaveral",
    name: "Cape Canaveral",
    // Cape Canaveral SFS (12) and Kennedy Space Center (27) are two
    // separate LL2 locations a few miles apart on the same barrier island —
    // treated as one "range" for bearing/eligibility purposes, the same way
    // a beachgoer would describe both as "the Cape."
    locationIds: [12, 27],
    fallbackLat: 28.49,
    fallbackLon: -80.55,
  },
  {
    key: "vandenberg",
    name: "Vandenberg",
    locationIds: [11],
    fallbackLat: 34.63,
    fallbackLon: -120.61,
  },
  {
    key: "wallops",
    name: "Wallops",
    locationIds: [21],
    fallbackLat: 37.86,
    fallbackLon: -75.47,
  },
  {
    key: "starbase",
    name: "Starbase",
    locationIds: [143],
    fallbackLat: 25.997,
    fallbackLon: -97.155,
  },
] as const;

export interface LaunchPad {
  lat: number;
  lon: number;
  name: string;
  locationId: number;
}

/**
 * Every LL2 `pad.id` -> its own coordinate, for the 4 ranges above, so the
 * great-circle bearing/distance (§7) uses the SPECIFIC pad a launch flies
 * from rather than a range-wide average (pads within Cape Canaveral SFS/KSC
 * alone span >15 miles). A `pad.id` LL2 returns that isn't listed here still
 * resolves via its range's fallback coordinate above, matched by
 * `padLocationId` — see `resolvePadCoordinate` in
 * lib/sources/launchLibrary.ts. Verified live 2026-09-28 (see header); 61
 * pads confirmed across the 5 LL2 locations that make up the 4 ranges.
 */
export const LAUNCH_PADS: Readonly<Record<number, LaunchPad>> = {
  // --- Cape Canaveral SFS (location 12) ---
  1: { lat: 28.4458, lon: -80.5657, name: "Space Launch Complex 17B", locationId: 12 },
  14: { lat: 28.4472, lon: -80.565, name: "Space Launch Complex 17A", locationId: 12 },
  17: { lat: 28.49103, lon: -80.54687, name: "Space Launch Complex 14", locationId: 12 },
  18: { lat: 28.506898, lon: -80.554169, name: "Launch Complex 19", locationId: 12 },
  19: { lat: 28.521811, lon: -80.56113, name: "Launch Complex 34", locationId: 12 },
  23: { lat: 28.533482, lon: -80.568101, name: "Space Launch Complex 37A", locationId: 12 },
  27: { lat: 28.4584, lon: -80.5284, name: "Space Launch Complex 46", locationId: 12 },
  29: { lat: 28.58341025, lon: -80.58303644, name: "Space Launch Complex 41", locationId: 12 },
  38: { lat: 28.5317, lon: -80.56495, name: "Space Launch Complex 37B", locationId: 12 },
  72: { lat: 28.458, lon: -80.528, name: "Unknown Pad", locationId: 12 },
  80: { lat: 28.56194122, lon: -80.57735736, name: "Space Launch Complex 40", locationId: 12 },
  92: { lat: 28.501626, lon: -80.5518, name: "Launch Complex 16", locationId: 12 },
  97: { lat: 28.4433, lon: -80.5712, name: "Launch Complex 26B", locationId: 12 },
  99: { lat: 28.480607, lon: -80.541938, name: "Launch Complex 12", locationId: 12 },
  116: { lat: 28.4755556, lon: -80.5427496, name: "Launch Complex 11", locationId: 12 },
  117: { lat: 28.4859, lon: -80.546594, name: "Space Launch Complex 13", locationId: 12 },
  118: { lat: 28.4493, lon: -80.564494, name: "Launch Complex 18A", locationId: 12 },
  119: { lat: 28.4493, lon: -80.564494, name: "Launch Complex 18B", locationId: 12 },
  120: { lat: 28.5122222, lon: -80.5588607, name: "Space Launch Complex 20", locationId: 12 },
  121: { lat: 28.4705556, lon: -80.542194, name: "Launch Complex 36A", locationId: 12 },
  122: { lat: 28.4705556, lon: -80.542194, name: "Launch Complex 36B", locationId: 12 },
  123: { lat: 28.43942, lon: -80.573301, name: "Launch Complex 5", locationId: 12 },
  193: { lat: 28.4433, lon: -80.5712, name: "Launch Complex 26A", locationId: 12 },
  206: { lat: 28.4963, lon: -80.5493, name: "Space Launch Complex 15", locationId: 12 },

  // --- Kennedy Space Center (location 27) ---
  4: { lat: 28.62711233, lon: -80.62101503, name: "Launch Complex 39B", locationId: 27 },
  30: { lat: 28.5990626125553, lon: -80.60428186, name: "Launch Complex 48", locationId: 27 },
  87: { lat: 28.60822681, lon: -80.60428186, name: "Launch Complex 39A", locationId: 27 },
  203: { lat: 28.60822681, lon: -80.60428186, name: "Launch Complex 39A Starship Pad", locationId: 27 },

  // --- Vandenberg SFB (location 11) ---
  8: { lat: 34.57635, lon: -120.63245, name: "Space Launch Complex 8", locationId: 11 },
  11: { lat: 34.5815, lon: -120.6262, name: "Space Launch Complex 6", locationId: 11 },
  16: { lat: 34.632, lon: -120.611, name: "Space Launch Complex 4E", locationId: 11 },
  24: { lat: 34.64, lon: -120.5895, name: "Space Launch Complex 3E", locationId: 11 },
  39: { lat: 34.7556, lon: -120.6224, name: "Space Launch Complex 2W", locationId: 11 },
  55: { lat: 34.739444, lon: -120.619167, name: "Space Launch Complex 576E", locationId: 11 },
  61: { lat: 34.7626, lon: -120.6213, name: "Space Launch Complex 10E", locationId: 11 },
  93: { lat: 34.644, lon: -120.593, name: "Space Launch Complex 3W", locationId: 11 },
  95: { lat: 34.7572, lon: -120.6303, name: "Space Launch Complex 1W", locationId: 11 },
  96: { lat: 34.756, lon: -120.6263, name: "Space Launch Complex 1E", locationId: 11 },
  98: { lat: 34.7516, lon: -120.6192, name: "Space Launch Complex 2E", locationId: 11 },
  154: { lat: 34.608, lon: -120.6247, name: "Space Launch Complex 5", locationId: 11 },
  156: { lat: 34.63312, lon: -120.61584, name: "Space Launch Complex 4W", locationId: 11 },
  169: { lat: 34.6638, lon: -120.6022, name: "Launch Complex A", locationId: 11 },
  170: { lat: 34.7897222, lon: -120.5980273, name: "576B3", locationId: 11 },
  171: { lat: 34.7652778, lon: -120.6244162, name: "Space Launch Complex 10W", locationId: 11 },
  172: { lat: 34.7394444, lon: -120.6213607, name: "576A2", locationId: 11 },
  173: { lat: 34.7394444, lon: -120.6213607, name: "576A1", locationId: 11 },
  174: { lat: 34.572855, lon: -120.632976, name: "Space Launch Complex 11", locationId: 11 },
  253: { lat: 34.560999, lon: -120.570646, name: "Space Launch Complex 14", locationId: 11 },

  // --- Wallops Flight Facility (location 21) ---
  56: { lat: 37.831, lon: -75.4911, name: "Launch Area 0 B", locationId: 21 },
  76: { lat: 37.8337, lon: -75.4881, name: "Launch Area 0 A", locationId: 21 },
  79: { lat: 37.833262, lon: -75.488235, name: "Rocket Lab Launch Complex 2 (Launch Area 0 C)", locationId: 21 },
  94: { lat: 37.8495, lon: -75.4725, name: "Launch Area 3", locationId: 21 },
  177: { lat: 37.9386111, lon: -75.4594162, name: "Unknown Pad", locationId: 21 },
  178: { lat: 37.8495, lon: -75.4725, name: "Launch Area 3A", locationId: 21 },
  195: { lat: 37.938611, lon: -75.457222, name: "Launch Area 1", locationId: 21 },
  196: { lat: 37.938611, lon: -75.457222, name: "Launch Area 4", locationId: 21 },
  234: { lat: 37.8321693, lon: -75.4899046, name: "Rocket Lab Launch Complex 3 (Launch Area 0 D)", locationId: 21 },

  // --- SpaceX Starbase (location 143) ---
  111: { lat: 25.997116, lon: -97.15503099856647, name: "Suborbital Pad A", locationId: 143 },
  187: { lat: 25.997116, lon: -97.15503099856647, name: "Suborbital Pad B", locationId: 143 },
  188: { lat: 25.9962, lon: -97.154423, name: "Orbital Launch Pad 1", locationId: 143 },
  235: { lat: 25.99677, lon: -97.15799, name: "Orbital Launch Pad 2", locationId: 143 },
} as const;
