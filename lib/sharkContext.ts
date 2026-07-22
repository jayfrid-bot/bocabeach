// ---------------------------------------------------------------------------
// Shark SEASONAL CONTEXT — not a live tracker, not a map, not a risk score.
//
// WHY NO LIVE DATA: the only free public shark-tracking feed (OCEARCH, via the
// Mapotic embed some beach apps use) is a stale last-known-position map of the
// wrong species for this coast — the nearest SE-Florida-tagged shark's most
// recent Atlantic ping dates to 2013. Showing that as if it were "sharks near
// you right now" would be actively misleading, worse than showing nothing. So
// this module deliberately uses ONLY signals we already have elsewhere in the
// app: calendar date, water temperature, recent weather, time of day, and the
// beach's fixed geography. It is a CONTEXT note, not a forecast.
//
// THE SCIENCE (SE-Florida Atlantic coast; citable to Florida Museum of Natural
// History shark research / FAU shark biology publications):
//
//   FALL MULLET RUN — every autumn, millions of baitfish (mostly striped
//   mullet) migrate south along the coast, pulling blacktip and spinner sharks
//   into the surf zone to feed. SE-Florida's window is primary Sep-Oct, with a
//   shoulder from late Aug through Nov. The trigger is the first cool fronts
//   that drop nearshore water temperature down through roughly 80°F — but this
//   is a SEASONAL pattern, not something forecastable for a specific day, so
//   water temperature here only corroborates the shoulder months, it never
//   substitutes for a real prediction.
//
//   WINTER BLACKTIP AGGREGATION — most winters, blacktip sharks aggregate near
//   shore (sometimes in large numbers, within tens of metres) along Palm Beach
//   and Boca Raton's beaches, part of a documented seasonal migration studied
//   by FAU's Shark Lab. The scale varies year to year — recent winters have run
//   smaller than the peak headlines — so this is worded as "can aggregate near
//   shore", not a guaranteed annual spectacle. The window runs roughly Dec-Mar
//   (the migration often begins with the first strong December cold fronts),
//   peaking late Feb-Mar, and is driven by water temperature — strongest at
//   ~26-27°N (exactly the Palm Beach/Boca latitude), the sharks moving north as
//   the water warms in spring. This is geographically narrow: it is NOT a
//   general Florida or SE-US phenomenon the way the mullet run is.
//
//   MICRO-FACTORS — independent of season, a few conditions are worth a bit of
//   extra awareness (never alarm): murky/turbid water (storm runoff, high
//   surf, strong onshore wind, heavy rain all reduce visibility for everyone
//   in the water, sharks included), dawn/dusk (the low-light hours many
//   nearshore species, including sharks and their prey, are most active),
//   and proximity to an inlet or river mouth (a natural funnel for baitfish
//   and the predators following them).
//
//   RARITY DENOMINATOR — always shown alongside any active reading. Shark
//   bites are rare events, and rarer still than sightings. Most of Florida's
//   nationally-leading bite count is driven by Volusia and Brevard county
//   inlets, more than 150 miles NORTH of SE Florida — but Palm Beach County is
//   NOT bite-free (it ranks among the state's higher-count counties, around
//   third historically), so the copy stays honest about local risk rather than
//   dismissing it as "a handful". Local incidents are typically minor
//   blacktip/spinner nips, across millions of beach visits.
//
// GEOGRAPHIC GATE: this entire module is SE-US-Atlantic-specific. `latDeg` is
// required (no default) because both mechanisms are latitude-bound: the
// mullet run applies along the Florida / SE-US Atlantic east coast, and the
// blacktip aggregation applies ONLY to the narrow SE-Florida band. Outside
// those bands the honest answer is `null`, same as a non-Atlantic coast. Note
// this module has no concept of Atlantic-vs-Gulf-facing (it only takes a
// latitude, not a longitude or coastline label) — see the integration note in
// the accompanying build report for how a caller should gate this by beach.
//
// DESIGN RULES enforced throughout:
//   - No numeric risk, probability, or shark count is ever computed or shown.
//   - No live shark positions, no map.
//   - Exception-only: `active` is only ever `true` (an inactive read returns
//     `null` entirely) — quiet by default, same philosophy as the tide-
//     aberration badges and the marine-stinger card.
//   - Every threshold below carries a rationale comment.
// ---------------------------------------------------------------------------

export type SharkSeason = "mullet-run" | "blacktip-aggregation";

/** Independent, additive micro-factors — never alarm on their own, only ever
 *  raise a soft awareness note alongside (or, combined, instead of) a season. */
export type SharkFactor = "murky water" | "dawn/dusk" | "near inlet";

export interface SharkContextRecentWeather {
  /** Surf noticeably up recently — churns the nearshore water column. */
  highSurf?: boolean;
  /** Sustained onshore wind speed (mph) — pushes swell and stirs sediment. */
  onshoreWindMph?: number;
  /** Rainfall in roughly the last day (inches) — runoff turbidity. */
  recentRainIn?: number;
  /** A storm passed through recently (independent of the two fields above —
   *  e.g. a caller that only has a boolean "there was a storm" signal). */
  stormRecent?: boolean;
}

export interface SharkContextInput {
  /** Local calendar month at the beach (1-12) — LOCAL to the beach, not the
   *  server's month. Both seasonal mechanisms are keyed off local calendar
   *  time (fall/winter at this latitude), so a server in a different time
   *  zone crossing a month boundary would otherwise misjudge the season. */
  month: number;
  /** Beach latitude, degrees. REQUIRED — see the geographic-gate note above. */
  latDeg: number;
  /** Current water temperature (°F), if known — corroborates the mullet-run
   *  shoulder months (see MULLET_RUN_SHOULDER_MAX_WATER_F). */
  waterTempF?: number;
  /** Turbidity-proxy weather signals (see SharkContextRecentWeather). */
  recentWeather?: SharkContextRecentWeather;
  /** Local hour of day, 0-23 — drives the dawn/dusk micro-factor. */
  localHour?: number;
  /** Distance to the nearest tidal inlet / river mouth, km, if known. */
  nearInletKm?: number;
}

export interface SharkContext {
  /** Always `true` — an inactive/quiet read is `null` at the top level, never
   *  an object with `active: false`. */
  active: true;
  /** Which seasonal pattern (if any) is driving this read. Independent of
   *  `factors` — a read can be factor-only with `season: null`. */
  season: SharkSeason | null;
  /** Active micro-factors, if any (see SharkFactor). */
  factors: SharkFactor[];
  /** Lightning-card-tone context sentence naming the active season + factors.
   *  Never a forecast, never a number-of-sharks, never a probability. */
  note: string;
  /** The mandatory rarity denominator — ALWAYS present whenever `active`. */
  rarityNote: string;
}

// --- Geographic gate ---------------------------------------------------------

/**
 * The wide SE-US Atlantic band the mullet run applies across — roughly the
 * Florida Keys (24°N) north through Cape Hatteras, NC (35°N), the stretch of
 * coast the mullet-run literature and SE-US shark-fishing/diving community
 * describe the migration running along. This is also used as the OVERALL
 * geographic gate for the whole module (the blacktip band below is a narrower
 * subset of it) — a beach outside this band gets `null` unconditionally,
 * regardless of month or micro-factors.
 */
const SE_US_ATLANTIC_LAT_MIN = 24;
const SE_US_ATLANTIC_LAT_MAX = 35;

/**
 * The narrow band the winter blacktip aggregation is documented in — centered
 * on the Palm Beach/Boca Raton latitude (~26.3°N) where FAU's Shark Lab has
 * tagged and tracked the aggregation. Deliberately much narrower than the
 * mullet-run band: this is NOT a general Florida phenomenon.
 */
const BLACKTIP_LAT_MIN = 25.5;
const BLACKTIP_LAT_MAX = 27.5;

function inSeUsAtlanticBand(latDeg: number): boolean {
  return latDeg >= SE_US_ATLANTIC_LAT_MIN && latDeg <= SE_US_ATLANTIC_LAT_MAX;
}

function inBlacktipBand(latDeg: number): boolean {
  return latDeg >= BLACKTIP_LAT_MIN && latDeg <= BLACKTIP_LAT_MAX;
}

// --- Mullet run --------------------------------------------------------------

/** Primary mullet-run months: September and October — the literature's core
 *  window, reliable enough to flag on the calendar alone. */
function isMulletRunPeak(month: number): boolean {
  return month === 9 || month === 10;
}

/** Shoulder mullet-run months: late August and November. Real, but less
 *  reliable than the peak — the fronts that trigger the run haven't
 *  necessarily arrived yet (Aug) or the run may already be tailing off (Nov),
 *  so a shoulder-month read additionally needs the water-temperature
 *  corroboration below before we'll call it "active". */
function isMulletRunShoulder(month: number): boolean {
  return month === 8 || month === 11;
}

/** "Cooling toward/below ~80°F" — the cool-front trigger the mullet-run
 *  literature describes. A couple of degrees of margin above the 80°F anchor
 *  (rather than a razor-exact match) because this is a corroborating signal
 *  for a SEASONAL pattern, not a precise day-of trigger. */
const MULLET_RUN_SHOULDER_MAX_WATER_F = 81;

function mulletRunCorroborated(waterTempF: number | undefined): boolean {
  return waterTempF != null && waterTempF <= MULLET_RUN_SHOULDER_MAX_WATER_F;
}

// --- Blacktip aggregation -----------------------------------------------------

/** Full blacktip-aggregation window: December through March. The SE-Florida
 *  migration often begins with the first strong December cold fronts (not only
 *  in the new year), so December is inside the window; peak stays late Feb-Mar. */
function isBlacktipWindow(month: number): boolean {
  return month === 12 || month === 1 || month === 2 || month === 3;
}

/** Documented peak of the aggregation: late February through March. */
function isBlacktipPeak(month: number): boolean {
  return month === 2 || month === 3;
}

// --- Season detection ----------------------------------------------------------

/**
 * Which seasonal pattern (if any) applies right now, given month + latitude
 * (+ optional water temp corroboration for the mullet-run shoulder). Returns
 * `null` outside both windows — the honest "nothing seasonal going on" case.
 */
function detectSeason(month: number, latDeg: number, waterTempF: number | undefined): SharkSeason | null {
  // Blacktip aggregation is geographically narrow and checked first: at this
  // exact latitude band, Jan-Mar unconditionally reads as the aggregation
  // window (no water-temp gate — the FAU tagging data ties this to the
  // calendar/latitude combination itself, not a single day's temperature).
  if (inBlacktipBand(latDeg) && isBlacktipWindow(month)) return "blacktip-aggregation";

  if (isMulletRunPeak(month)) return "mullet-run";
  if (isMulletRunShoulder(month) && mulletRunCorroborated(waterTempF)) return "mullet-run";

  return null;
}

// --- Micro-factors -------------------------------------------------------------

/** Onshore wind strong enough to be actively churning the nearshore water
 *  column and reducing visibility — same rough "sustained onshore" register
 *  used elsewhere in the app (see lib/marineStinger.ts), not a gale. */
const TURBID_ONSHORE_WIND_MPH = 15;

/** Roughly half an inch of rain in the last day is enough runoff to visibly
 *  cloud nearshore water at most SE-Florida beaches. */
const TURBID_RECENT_RAIN_IN = 0.5;

function isMurky(weather: SharkContextRecentWeather | undefined): boolean {
  if (!weather) return false;
  if (weather.highSurf) return true;
  if (weather.stormRecent) return true;
  if (weather.onshoreWindMph != null && weather.onshoreWindMph >= TURBID_ONSHORE_WIND_MPH) return true;
  if (weather.recentRainIn != null && weather.recentRainIn >= TURBID_RECENT_RAIN_IN) return true;
  return false;
}

/** Dawn window: roughly 5-8 AM local. */
function isDawn(localHour: number): boolean {
  return localHour >= 5 && localHour <= 8;
}

/** Dusk window: roughly 6-9 PM local. */
function isDusk(localHour: number): boolean {
  return localHour >= 18 && localHour <= 21;
}

/** Close enough to an inlet mouth that the funnel effect plausibly applies —
 *  a couple of km covers "this beach sits right by the inlet" without
 *  reaching into "technically the same county". */
const NEAR_INLET_KM = 2;

function detectFactors(input: SharkContextInput): SharkFactor[] {
  const factors: SharkFactor[] = [];
  if (isMurky(input.recentWeather)) factors.push("murky water");
  if (input.localHour != null && (isDawn(input.localHour) || isDusk(input.localHour))) {
    factors.push("dawn/dusk");
  }
  if (input.nearInletKm != null && input.nearInletKm <= NEAR_INLET_KM) factors.push("near inlet");
  return factors;
}

/** A combo worth surfacing on its own, even with no season active: reduced
 *  visibility PLUS the low-light hours together, not either alone — matches
 *  the spec's "meaningful turbidity+time factor combo" bar for `active`. */
function hasMeaningfulFactorCombo(factors: SharkFactor[]): boolean {
  return factors.includes("murky water") && factors.includes("dawn/dusk");
}

// --- Note composition ------------------------------------------------------

function seasonSentence(season: SharkSeason, month: number, waterTempF: number | undefined): string {
  if (season === "mullet-run") {
    if (isMulletRunPeak(month)) {
      return (
        "It's peak mullet-run season on this stretch of coast (roughly Sep-Oct) — baitfish migrating south " +
        "pull blacktip and spinner sharks close to the surf to feed."
      );
    }
    const cooling = mulletRunCorroborated(waterTempF) ? ", and the water's cooling the way the run's cold-front trigger usually looks" : "";
    return (
      "It's the shoulder of mullet-run season here (the run typically runs late Aug-Nov, peaking Sep-Oct)" +
      cooling +
      " — baitfish migrations can pull sharks into the surf zone."
    );
  }
  // blacktip-aggregation
  if (isBlacktipPeak(month)) {
    return (
      "It's peak blacktip shark aggregation season on this stretch of coast (roughly late Feb-Mar) — in many " +
      "winters large numbers of blacktips aggregate near shore here, moving on as the water warms in spring."
    );
  }
  return (
    "SE Florida's winter blacktip aggregation window is open here (roughly Dec-Mar, peaking late Feb-Mar) — " +
    "some winters see blacktips aggregate close to shore along this stretch of coast."
  );
}

function factorsSentence(factors: SharkFactor[]): string | null {
  if (factors.length === 0) return null;
  const parts: string[] = [];
  if (factors.includes("murky water")) parts.push("the water's murkier than usual");
  if (factors.includes("dawn/dusk")) parts.push("it's dawn/dusk, the lower-light hours");
  if (factors.includes("near inlet")) parts.push("this spot sits close to an inlet");
  const joined =
    parts.length === 1
      ? parts[0]
      : parts.length === 2
        ? `${parts[0]} and ${parts[1]}`
        : `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
  return `Worth a bit of extra awareness: ${joined}.`;
}

/** The mandatory rarity denominator — always shown alongside any active read.
 *  Non-alarmist but honest: Palm Beach County is not a no-risk coast (it ranks
 *  among Florida's higher-bite counties, historically around third statewide),
 *  so we don't dismiss local bites as "a handful" or pin everything on the
 *  counties to the north. */
const RARITY_NOTE =
  "Keep it in perspective: a shark bite is rare, and far rarer than just seeing one. Most of Florida's " +
  "nationally-leading bites happen at the Volusia and Brevard county inlets 150+ miles north — but Palm Beach " +
  "County isn't bite-free either (it ranks among the state's higher counties, historically around third), and " +
  "local incidents are typically minor blacktip/spinner nips. Normal water-smart caution is the right call, not alarm.";

function buildNote(season: SharkSeason | null, factors: SharkFactor[], month: number, waterTempF: number | undefined): string {
  if (season) {
    const parts = [seasonSentence(season, month, waterTempF)];
    const fSentence = factorsSentence(factors);
    if (fSentence) parts.push(fSentence);
    return parts.join(" ");
  }
  // Factor-only trigger (no season active) — always non-empty when this path
  // is reached, since `active` requires a meaningful factor combo here.
  return (
    `${factorsSentence(factors)} These conditions can bring more nearshore activity from sharks and their prey ` +
    "alike — nothing specific to report, just a good moment for normal water-smart caution."
  );
}

// --- Public API --------------------------------------------------------------

/**
 * Seasonal shark CONTEXT for a beach — never a live tracker, never a map,
 * never a risk score (see the module header for why). Returns `null` for the
 * quiet, exception-only default case: outside the SE-US Atlantic geographic
 * band entirely, or in-region but with nothing seasonal or notable going on
 * right now (see `active` in SharkContext, and `hasMeaningfulFactorCombo`).
 */
export function sharkContext(input: SharkContextInput): SharkContext | null {
  if (!inSeUsAtlanticBand(input.latDeg)) return null;

  const season = detectSeason(input.month, input.latDeg, input.waterTempF);
  const factors = detectFactors(input);
  const active = season !== null || hasMeaningfulFactorCombo(factors);

  if (!active) return null;

  return {
    active: true,
    season,
    factors,
    note: buildNote(season, factors, input.month, input.waterTempF),
    rarityNote: RARITY_NOTE,
  };
}
