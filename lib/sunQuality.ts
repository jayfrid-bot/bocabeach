// ---------------------------------------------------------------------------
// Sunrise / sunset "sky show" quality — will the sky put on a color show at
// the next sun event, or is it a bust?
//
// The recipe (meteorology, not vibes): a vivid sunrise/sunset needs a mid/high
// cloud DECK to act as a canvas the low sun's red/orange light can paint onto.
//   - Mid/high cloud ~30-60% = the sweet spot: enough surface up there to
//     catch color, not so much it blocks the sun outright.
//   - Near-0% cloud = clean but plain — nothing up there to paint color onto.
//   - Heavy LOW cloud (near-total, ~85%+) is the opposite of magic: it sits
//     right at the horizon and blocks the direct beam before it ever reaches
//     whatever's above, so it kills the show independent of the mid/high deck.
//   - Crisp, dry air (humidity <60%) helps a little — haze muddies color.
//
// ISOLATED MODULE: built stand-alone per an integration agent's plan. Nothing
// here imports from lib/types.ts or any live data source on purpose — the
// public functions take small, structurally-typed inputs so a real
// HourlyMetrics[] (or a future cloud-by-level payload) can be passed in
// without this module needing to know the app's exact fetch shapes. See the
// bottom of this file for the wiring note this was built against.
//
// lerpCurve is duplicated here rather than imported (same call lib/stormActivity.ts
// makes) so this stays a small, dependency-free, pure unit under test.
// ---------------------------------------------------------------------------

export type SunEventKind = "sunrise" | "sunset";

export type SunQualityBand = "dud" | "plain" | "good" | "vivid" | "epic";

/**
 * Cloud reading for one event hour. All fields optional — that's the point:
 * this app currently only fetches TOTAL cloud cover (see the integration note
 * at the bottom of this file), so most real calls will only carry `totalPct`.
 * `lowPct`/`midPct`/`highPct` are here so the scoring can use them the moment
 * a cloud-by-level fetch exists, with zero changes to the curve logic.
 */
export interface CloudMix {
  /** Low-cloud cover, 0-100. Sits at/near the horizon — heavy low cloud
   *  blocks the direct beam and can kill the show regardless of what's above it. */
  lowPct?: number;
  /** Mid-cloud cover, 0-100 — the classic color canvas: catches the low sun's
   *  red/orange light without blocking the view of the sun itself. */
  midPct?: number;
  /** High (cirrus) cloud cover, 0-100 — thin and high, also catches color well. */
  highPct?: number;
  /** Total cloud cover, 0-100 — the fallback when the level split isn't available. */
  totalPct?: number;
}

/**
 * Satellite-observed clearness along the low-sun beam/horizon path (GOES ABI,
 * via lib/sources/goesCloud.ts's `beamCloudPct`). This is the single most
 * science-backed input — a clear horizon is what lets the low sun's beam reach
 * the cloud canvas at all. `fresh` is set by the caller ONLY when the satellite
 * granule is current AND the event is imminent (a "right now" observation can't
 * speak for a sunrise 12 hours out); when it's stale/far, the model degrades to
 * a low-cloud estimate and says the horizon path is unverified.
 */
export interface HorizonPath {
  /** 0-100 cloud fraction along the beam/horizon path. */
  cloudPct: number;
  /** Caller vouches this satellite sample is current AND near the event time. */
  fresh: boolean;
}

export interface SunEventQualityInput {
  /** Cloud reading at the event hour. `undefined` (or every field unset) means
   *  "we don't have a forecast for that hour" → honest-null result. */
  cloud: CloudMix | undefined;
  /** Relative humidity at the event hour, 0-100. */
  humidityPct?: number;
  /** Aerosol optical depth (CAMS, via Open-Meteo air quality) — dimensionless.
   *  Very clean air (<0.15) is a mild bonus; haze/dust ramps a penalty. */
  aod?: number;
  /** PM2.5, µg/m³ — an elevated boundary-layer smoke penalty. */
  pm2_5?: number;
  /** Satellite beam/horizon-path clearness (see HorizonPath). When present, the
   *  richer factor model engages; when a `fresh` sample is present it drives the
   *  highest-weighted clear-path factor directly. */
  horizon?: HorizonPath;
  /** Seasonal color-climatology prior, 0-100. Small and near-flat at low
   *  latitudes (26°N). Defaults to a neutral 55 when the caller has none. */
  seasonalPrior?: number;
}

/** Transparent per-factor breakdown (the spinoff app's differentiator) — each
 *  string is a plain-English one-liner for the flip-card back. Only populated
 *  on the richer factor-model path; the fallback path leaves it undefined. */
export interface SunFactorBreakdown {
  /** e.g. "clear (satellite)" / "unverified — est. from low cloud". */
  horizonPath: string;
  /** e.g. "55% mid-high". */
  cloudCanvas: string;
  /** e.g. "good (AOD 0.09)". Omitted when no aerosol reading. */
  airClarity?: string;
  /** e.g. "muggy −10%". Omitted when humidity isn't a factor. */
  humidity?: string;
}

export interface SunEventQuality {
  /** 0-100, or null when there's no forecast cloud reading for the event hour. */
  score: number | null;
  /** null exactly when score is null. */
  band: SunQualityBand | null;
  /** One-line, plain-English explanation of the score. */
  note: string;
  /** Transparent factor breakdown — present only when the richer factor model
   *  ran (the simpler fallback path leaves it undefined). */
  breakdown?: SunFactorBreakdown;
}

export interface SunQualityBandMeta {
  band: SunQualityBand;
  label: string;
  /** Accent hex for the band (dull slate → sunset orange). */
  color: string;
}

/** Highest-scoring band last, low-scoring band first — display/legend order. */
export const SUN_QUALITY_BANDS: readonly SunQualityBandMeta[] = [
  { band: "dud", label: "Dud", color: "#64748b" }, // slate-500
  { band: "plain", label: "Plain", color: "#94a3b8" }, // slate-400
  { band: "good", label: "Good", color: "#fbbf24" }, // amber-400
  { band: "vivid", label: "Vivid", color: "#fb923c" }, // orange-400
  { band: "epic", label: "Epic", color: "#f97316" }, // orange-500
] as const;

export function sunQualityBandMeta(band: SunQualityBand): SunQualityBandMeta {
  return SUN_QUALITY_BANDS.find((b) => b.band === band) ?? SUN_QUALITY_BANDS[0];
}

// --- small pure helpers (no deps) -------------------------------------------

const clamp = (n: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, n));

/** Piecewise-linear interpolation through ordered [x,y] anchors — same shape
 *  as lib/stormActivity.ts's private lerpCurve / lib/nerdInfo.ts's lerpCurve.
 *  Duplicated (not imported) to keep this module dependency-free. */
function lerpCurve(x: number, anchors: readonly (readonly [number, number])[]): number {
  if (x <= anchors[0][0]) return anchors[0][1];
  const last = anchors[anchors.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < anchors.length; i++) {
    const [x1, y1] = anchors[i];
    if (x <= x1) {
      const [x0, y0] = anchors[i - 1];
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return last[1];
}

// --- the core curves ---------------------------------------------------------

/**
 * Score vs. combined mid/high cloud %, when we actually know the level split.
 * 0% → 40 (clear, clean but plain). Peaks 90-97 across 30-60%, topping out at
 * 45% (the textbook ratio). Falls off hard past ~75% (mid/high alone starting
 * to look like solid overcast, less room for light to get through the gaps).
 */
const LEVEL_BASED_CURVE: readonly (readonly [number, number])[] = [
  [0, 40],
  [10, 52],
  [20, 68],
  [30, 90],
  [45, 97],
  [60, 90],
  [75, 60],
  [85, 35],
  [100, 15],
];

/**
 * Score vs. TOTAL cloud %, used only when we don't know the level split.
 * Deliberately flatter and lower-ceilinged than LEVEL_BASED_CURVE: a 45%
 * total reading could be a perfect mid/high canvas OR a mediocre low deck —
 * we can't tell, so we refuse to promise the 90+ "epic" the level-based path
 * can reach. Still agrees with the level-based curve at 0% (both describe the
 * same clear-sky reality).
 */
const TOTAL_ONLY_CURVE: readonly (readonly [number, number])[] = [
  [0, 40],
  [20, 55],
  [40, 68],
  [60, 63],
  [80, 42],
  [100, 18],
];

/**
 * Combine independent mid + high cloud fractions into one "color canvas" %,
 * via a screen blend (1 − (1−m)(1−h)) rather than a naive sum — two
 * partially-overlapping decks stacked overhead don't just add.
 */
function combineMidHigh(midPct: number, highPct: number): number {
  const m = clamp(midPct, 0, 100) / 100;
  const h = clamp(highPct, 0, 100) / 100;
  return Math.round((1 - (1 - m) * (1 - h)) * 100);
}

/**
 * Multiplicative penalty for low cloud. <=30% low cloud costs nothing (the
 * "low cloud <30%" condition for hitting the peak). From 30% to 85% it decays
 * steeply — low cloud sitting right at the horizon is the thing most likely to
 * physically block the beam. By 85%+ (near-total low overcast) the factor is
 * small enough that even a perfect 97 mid/high base lands in the "dud" band
 * (5-15), matching the ">85% low overcast = dud" spec regardless of what's above it.
 */
function lowCloudFactor(lowPct: number): number {
  const l = clamp(lowPct, 0, 100);
  if (l <= 30) return 1;
  if (l <= 85) return 1 - ((l - 30) / 55) * 0.85; // 1.0 -> 0.15
  return 0.15 - ((l - 85) / 15) * 0.1; // 0.15 -> 0.05
}

/** Small bonus for crisp, dry air (<60% RH) — up to +5 at ~30% RH or drier. */
function humidityBonus(humidityPct: number | undefined): number {
  if (humidityPct == null || humidityPct >= 60) return 0;
  return clamp((60 - humidityPct) / 6, 0, 5);
}

// --- richer FACTOR MODEL (engaged when the complete level split plus at least
// one atmospheric/satellite signal is available) ----------------------------
//
// Composite = 0.40·clearPath + 0.40·canvas + 0.20·seasonalPrior, then scaled by
// multiplicative aerosol × humidity modifiers. Every constant below is a tuned
// HEURISTIC unless flagged otherwise — the low-cloud clear-path blocker is the
// well-supported physics (Corfidi/NOAA); the exact slopes are judgement calls.

/**
 * CANVAS: how good the cloud "screen" overhead is at catching color. Peaks when
 * the high-weighted cloud amount (0.5·mid + 0.7·high) sits near ~50% — HIGH
 * cloud is weighted above mid because thin cirrus catches the reddened light
 * best (RESEARCH-BACKED direction); the |·|·2.2 falloff and the −0.9·low term
 * (low cloud dulls the canvas even before it blocks the beam) are HEURISTIC
 * slopes. Spec formula, clamped 0-100.
 */
function canvasScore(lowPct: number, midPct: number, highPct: number): number {
  return clamp(100 - Math.abs(0.5 * midPct + 0.7 * highPct - 50) * 2.2 - lowPct * 0.9, 0, 100);
}

/**
 * CLEAR-PATH (highest-weighted, most science-backed): can the low sun's beam
 * actually reach the canvas, or is the horizon socked in? A FRESH satellite
 * beam-path sample is used directly (100 − beamCloud%); otherwise we degrade to
 * a low-cloud estimate (HEURISTIC 1.1× slope — low cloud sits right at the
 * horizon) and flag the horizon path as unverified.
 */
function clearPathScore(
  lowPct: number,
  horizon: HorizonPath | undefined,
): { score: number; verified: boolean } {
  if (horizon && horizon.fresh) {
    return { score: clamp(100 - clamp(horizon.cloudPct, 0, 100), 0, 100), verified: true };
  }
  return { score: clamp(100 - lowPct * 1.1, 0, 100), verified: false };
}

/**
 * AEROSOL modifier (multiplicative). Mild bonus for very clean air (AOD < 0.15);
 * above that a penalty ramps, capped at −25%. An elevated PM2.5 adds a separate
 * boundary-layer-smoke penalty capped at −35%. All thresholds/slopes HEURISTIC.
 * NOTE (flagged future enhancement, v1 skips it): a STRATOSPHERIC-aerosol branch
 * (volcanic/wildfire-smoke plumes aloft, which enhance rather than mute color)
 * is deliberately out of scope here.
 */
function aerosolModifier(aod: number | undefined, pm2_5: number | undefined): number {
  let m = 1;
  if (aod != null) {
    m *= aod < 0.15 ? 1.05 : clamp(1 - (aod - 0.15) * 0.5, 0.75, 1); // bonus / ramp, cap −25%
  }
  if (pm2_5 != null && pm2_5 > 35) {
    // PM2.5 > 35 µg/m³ ≈ the "unhealthy for sensitive groups" boundary — hazy,
    // muted low sun. Ramp to −35% by ~135 µg/m³ (heavy smoke).
    m *= clamp(1 - (pm2_5 - 35) * 0.0035, 0.65, 1);
  }
  return m;
}

/** HUMIDITY modifier (multiplicative): mild penalty above 60% RH, capped at
 *  −15% (reached near saturation). HEURISTIC slope. */
function humidityModifier(humidityPct: number | undefined): number {
  if (humidityPct == null || humidityPct <= 60) return 1;
  return clamp(1 - (humidityPct - 60) * 0.00375, 0.85, 1); // 60%→1.0, 100%→0.85
}

/** Neutral, near-flat seasonal color prior (26°N has little seasonal swing). */
const DEFAULT_SEASONAL_PRIOR = 55; // HEURISTIC

function airClarityWord(aod: number): string {
  if (aod < 0.1) return "excellent";
  if (aod < 0.2) return "good";
  if (aod < 0.35) return "hazy";
  return "very hazy";
}

/** The richer factor-model scorer. Called only once the caller has a complete
 *  level split AND at least one atmospheric/satellite signal (see sunEventQuality). */
function factorModelQuality(
  cloud: CloudMix,
  input: SunEventQualityInput,
): SunEventQuality {
  const lowPct = clamp(cloud.lowPct ?? 0, 0, 100);
  const midPct = clamp(cloud.midPct ?? 0, 0, 100);
  const highPct = clamp(cloud.highPct ?? 0, 0, 100);
  const midHigh = combineMidHigh(midPct, highPct);

  const canvas = canvasScore(lowPct, midPct, highPct);
  const { score: clearPath, verified } = clearPathScore(lowPct, input.horizon);
  const prior = clamp(input.seasonalPrior ?? DEFAULT_SEASONAL_PRIOR, 0, 100);

  const base = 0.4 * clearPath + 0.4 * canvas + 0.2 * prior;
  const aeroMod = aerosolModifier(input.aod, input.pm2_5);
  const humidMod = humidityModifier(input.humidityPct);
  const score = Math.round(clamp(base * aeroMod * humidMod, 0, 100));
  const band = bandFor(score);

  const breakdown: SunFactorBreakdown = {
    horizonPath: verified
      ? `clear ${Math.round(clearPath)}/100 (satellite)`
      : `~${Math.round(clearPath)}/100 — unverified, est. from ${Math.round(lowPct)}% low cloud`,
    cloudCanvas: `${Math.round(midHigh)}% mid-high`,
  };
  if (input.aod != null) {
    breakdown.airClarity = `${airClarityWord(input.aod)} (AOD ${input.aod.toFixed(2)})`;
  } else if (input.pm2_5 != null && input.pm2_5 > 35) {
    breakdown.airClarity = `smoky (PM2.5 ${Math.round(input.pm2_5)})`;
  }
  if (humidMod < 1) {
    breakdown.humidity = `muggy ${Math.round((humidMod - 1) * 100)}%`;
  }

  const note = factorNote({ band, midHigh, lowPct, verified, aeroMod, humidMod });
  return { score, band, note, breakdown };
}

function factorNote(opts: {
  band: SunQualityBand;
  midHigh: number;
  lowPct: number;
  verified: boolean;
  aeroMod: number;
  humidMod: number;
}): string {
  const { band, midHigh, lowPct, verified, aeroMod, humidMod } = opts;
  if (lowPct >= 85) {
    return `Low cloud is blanketing the horizon (~${Math.round(lowPct)}%) — it blocks the beam before it reaches the color canvas above.`;
  }
  const horizon = verified ? " (horizon confirmed clear by satellite)" : "";
  const air = aeroMod > 1 ? " Clean, crisp air helps." : aeroMod < 0.9 ? " Hazy air is muting it." : "";
  const muggy = humidMod < 0.95 ? " Muggy air takes the edge off." : "";
  if (band === "epic" || band === "vivid") {
    return `~${Math.round(midHigh)}% mid/high cloud with a clear enough path — expect a real show${horizon}.${air}${muggy}`;
  }
  if (band === "good") {
    return `~${Math.round(midHigh)}% mid/high cloud — some color potential${horizon}.${air}${muggy}`;
  }
  if (midHigh <= 12) {
    return `Near-clear sky (~${Math.round(midHigh)}% mid/high) — clean light, but little up there to catch color.${air}`;
  }
  return `~${Math.round(midHigh)}% mid/high cloud — not the right mix for strong color${horizon}.${air}${muggy}`;
}

const BAND_CUTOFFS: readonly { min: number; band: SunQualityBand }[] = [
  { min: 90, band: "epic" },
  { min: 70, band: "vivid" },
  { min: 45, band: "good" },
  { min: 20, band: "plain" },
  { min: 0, band: "dud" },
];

function bandFor(score: number): SunQualityBand {
  for (const c of BAND_CUTOFFS) if (score >= c.min) return c.band;
  return "dud";
}

function buildNote(opts: {
  hasLevelSplit: boolean;
  midHigh: number;
  lowPct: number;
  band: SunQualityBand;
  bonus: number;
}): string {
  const { hasLevelSplit, midHigh, lowPct, band, bonus } = opts;
  const crisp = bonus > 0 ? " Crisp, drier air helps too." : "";

  if (!hasLevelSplit) {
    const phrase =
      band === "epic" || band === "vivid"
        ? "there's likely a decent deck up there"
        : band === "good"
          ? "there's a moderate deck up there"
          : band === "plain"
            ? "not much is up there to catch the light"
            : "heavy cloud is likely in the way";
    return `Cloud mix unknown (only total cover on file) — ${phrase}, so this is a rougher guess.${crisp}`;
  }

  if (lowPct >= 85) {
    return `Low cloud is blanketing the horizon (~${Math.round(lowPct)}%) — it blocks the light before it ever reaches whatever's above.`;
  }
  if (band === "epic" || band === "vivid") {
    return `~${Math.round(midHigh)}% mid/high cloud is right in the color-canvas sweet spot — expect a real show.${crisp}`;
  }
  if (midHigh <= 12) {
    return `Clear sky (~${Math.round(midHigh)}% mid/high) — clean light, but nothing up there to paint color onto.${crisp}`;
  }
  if (band === "good") {
    return `~${Math.round(midHigh)}% mid/high cloud — some color potential, short of the 30-60% sweet spot.${crisp}`;
  }
  return `~${Math.round(midHigh)}% mid/high cloud — too little or too much up there for real color.${crisp}`;
}

/**
 * Score how likely the NEXT sunrise/sunset is to put on a color show, 0-100.
 * Pure: no network, no clock reads (`humidityPct`/`cloud` are handed in).
 *
 * - With a level split (any of `lowPct`/`midPct`/`highPct` present): scores
 *   off the combined mid/high "color canvas" %, peaking 90-97 across 30-60%
 *   mid/high with low cloud under 30%, then multiplicatively penalized by low
 *   cloud (a heavy low deck can drag even a perfect mid/high reading into the
 *   "dud" band — see `lowCloudFactor`).
 * - With only `totalPct` (today's actual fetch — see integration note below):
 *   uses a flatter, lower-ceiling curve, since we can't tell a beneficial
 *   mid/high deck from a damaging low one, and says so in `note`.
 * - With neither: honest-null (`score`/`band` are `null`) rather than a
 *   fabricated number.
 */
export function sunEventQuality(input: SunEventQualityInput): SunEventQuality {
  const cloud = input.cloud;
  // Require the COMPLETE low/mid/high split before trusting the level-based
  // curve. A PARTIAL split (e.g. only `lowPct`) would let the missing levels
  // default to 0 in combineMidHigh/lowCloudFactor and fabricate a "clear color
  // canvas" we actually have no reading for — reading a possibly-vivid sky as
  // plain. With an incomplete split, fall back to the flatter total-cloud curve
  // (self-labeled "cloud mix unknown") when total cover is available, else the
  // honest-null "no reading" state.
  const hasLevelSplit =
    !!cloud && cloud.lowPct != null && cloud.midPct != null && cloud.highPct != null;
  const hasTotalOnly = !hasLevelSplit && !!cloud && cloud.totalPct != null;

  if (!hasLevelSplit && !hasTotalOnly) {
    return {
      score: null,
      band: null,
      note: "No forecast cloud reading for this event hour yet.",
    };
  }

  // Richer factor model: engages only with a COMPLETE level split AND at least
  // one atmospheric/satellite signal (aerosol, PM2.5, or a beam-path reading).
  // With just the cloud split (no air/satellite inputs) we keep the simpler,
  // well-characterized curve path below — that's the documented fallback.
  const hasRichSignal =
    input.aod != null || input.pm2_5 != null || input.horizon != null;
  if (hasLevelSplit && hasRichSignal) {
    return factorModelQuality(cloud!, input);
  }

  let base: number;
  let midHigh = 0;
  const lowPct = hasLevelSplit ? clamp(cloud!.lowPct ?? 0, 0, 100) : 0;

  if (hasLevelSplit) {
    midHigh = combineMidHigh(cloud!.midPct ?? 0, cloud!.highPct ?? 0);
    base = lerpCurve(midHigh, LEVEL_BASED_CURVE) * lowCloudFactor(lowPct);
  } else {
    const total = clamp(cloud!.totalPct ?? 0, 0, 100);
    base = lerpCurve(total, TOTAL_ONLY_CURVE);
  }

  const bonus = humidityBonus(input.humidityPct);
  const score = Math.round(clamp(base + bonus, 0, 100));
  const band = bandFor(score);
  const note = buildNote({ hasLevelSplit, midHigh, lowPct, band, bonus });

  return { score, band, note };
}

// --- event selection ----------------------------------------------------------

/**
 * Fixed golden-hour window length, in minutes — the FALLBACK only. The true
 * window comes from a solar-elevation solve (golden hour = +6° down to −4°,
 * straddling the event — see lib/sources/sun.ts), threaded in via `windows`
 * below. This flat 60-min stand-in is used only when that elevation window is
 * unavailable (e.g. an older cached snapshot with no golden-hour fields).
 */
export const GOLDEN_HOUR_MINUTES = 60;
const GOLDEN_HOUR_MS = GOLDEN_HOUR_MINUTES * 60_000;

export interface SunEventTime {
  event: SunEventKind;
  /** ISO time of the event. */
  timeIso: string;
  /** ISO start of the golden-hour window around this event. */
  goldenStartIso: string;
  /** ISO end of the golden-hour window around this event. */
  goldenEndIso: string;
  /** true when the golden window came from the real elevation solve (spans past
   *  the event); false when it fell back to the fixed ±60-min approximation. */
  goldenFromElevation: boolean;
  /** Peak-color anchor (sun ~−3°), ISO — only when the elevation solve supplied
   *  it. Fed to `peakColorTime`; absent on the fixed-window fallback. */
  peakAnchorIso?: string;
}

/** The real elevation-derived golden window + peak anchor for one event side.
 *  Any field may be absent (older snapshot) → the caller falls back per-field. */
export interface GoldenWindowIso {
  goldenStartIso?: string;
  goldenEndIso?: string;
  peakAnchorIso?: string;
}

/** Sun times for the card, optionally carrying the real elevation windows. The
 *  bare sunrise/sunset stay required-ish (optional strings) for back-compat with
 *  callers that only have those; the golden windows are additive. */
export interface SunEventTimes {
  sunrise?: string;
  sunset?: string;
  /** Real morning golden window (sun −4°→+6°) + peak anchor, when available. */
  goldenAm?: GoldenWindowIso;
  /** Real evening golden window (sun +6°→−4°) + peak anchor, when available. */
  goldenEve?: GoldenWindowIso;
}

/** Builds the golden-hour window for an event, preferring the real
 *  elevation-derived window and degrading to the fixed ±60-min approximation
 *  (sunrise → sunrise+60min; sunset−60min → sunset) when it's unavailable. */
function goldenWindow(
  event: SunEventKind,
  timeIso: string,
  real: GoldenWindowIso | undefined,
): Pick<SunEventTime, "goldenStartIso" | "goldenEndIso" | "goldenFromElevation" | "peakAnchorIso"> {
  if (real?.goldenStartIso && real.goldenEndIso) {
    return {
      goldenStartIso: real.goldenStartIso,
      goldenEndIso: real.goldenEndIso,
      goldenFromElevation: true,
      peakAnchorIso: real.peakAnchorIso,
    };
  }
  const t = Date.parse(timeIso);
  if (event === "sunrise") {
    return {
      goldenStartIso: timeIso,
      goldenEndIso: new Date(t + GOLDEN_HOUR_MS).toISOString(),
      goldenFromElevation: false,
    };
  }
  return {
    goldenStartIso: new Date(t - GOLDEN_HOUR_MS).toISOString(),
    goldenEndIso: timeIso,
    goldenFromElevation: false,
  };
}

/**
 * Which sun event the card should show next: today's sunrise if it hasn't
 * happened yet, else today's sunset if that hasn't happened yet, else
 * tomorrow's sunrise. Pure — `now` is injected so it's testable without
 * mocking the clock. Returns null (honest-null) only when there's truly
 * nothing to show (no sun times at all, e.g. a fetch failure with no
 * tomorrow fallback supplied). Each result carries its golden-hour window
 * (real elevation window when available, else the ±60-min fallback).
 *
 * `today` may carry the real `goldenAm`/`goldenEve` windows; `tomorrow` (a
 * sunrise ISO plus its optional morning golden window) is used once today's
 * sunset has passed. Both back-compat: old callers pass just sunrise/sunset.
 */
export function nextSunEvent(
  now: Date,
  today: SunEventTimes,
  tomorrow?: string | { sunriseIso?: string; goldenAm?: GoldenWindowIso },
): SunEventTime | null {
  const nowMs = now.getTime();
  const tmr =
    typeof tomorrow === "string" ? { sunriseIso: tomorrow, goldenAm: undefined } : tomorrow;

  const sunriseMs = today.sunrise ? Date.parse(today.sunrise) : NaN;
  if (Number.isFinite(sunriseMs) && nowMs < sunriseMs) {
    return {
      event: "sunrise",
      timeIso: today.sunrise!,
      ...goldenWindow("sunrise", today.sunrise!, today.goldenAm),
    };
  }

  const sunsetMs = today.sunset ? Date.parse(today.sunset) : NaN;
  if (Number.isFinite(sunsetMs) && nowMs < sunsetMs) {
    return {
      event: "sunset",
      timeIso: today.sunset!,
      ...goldenWindow("sunset", today.sunset!, today.goldenEve),
    };
  }

  if (tmr?.sunriseIso) {
    return {
      event: "sunrise",
      timeIso: tmr.sunriseIso,
      ...goldenWindow("sunrise", tmr.sunriseIso, tmr.goldenAm),
    };
  }

  return null;
}

export interface PeakColorTime {
  /** ISO of the estimated peak-color moment. */
  iso: string;
  /** Signed minutes from the event (negative = before sunrise / after nothing;
   *  positive = after sunset). */
  minutesFromEvent: number;
}

/**
 * When the richest color is likely to peak. Per the research spec: with a
 * meaningful high-cloud deck (≥15%) AND a reasonably clear horizon, peak color
 * lags the event to when the sun sits around −2° to −4° (the −3° anchor from
 * the elevation solve) — capped at 30 min from the event; otherwise peak is
 * essentially at the event itself. Pure. Returns null when there's no event
 * time to anchor to.
 */
export function peakColorTime(args: {
  event: SunEventKind;
  eventIso: string | undefined;
  /** Sun −3° crossing on the event side (post-sunset / pre-sunrise). */
  peakAnchorIso?: string;
  highPct?: number;
  /** Clear-path score 0-100 (from the factor model); ≥50 counts as "clear". */
  clearPathScore?: number;
}): PeakColorTime | null {
  const eventMs = args.eventIso ? Date.parse(args.eventIso) : NaN;
  if (!Number.isFinite(eventMs)) return null;

  const highEnough = (args.highPct ?? 0) >= 15;
  const clearEnough = args.clearPathScore == null || args.clearPathScore >= 50;
  const anchorMs = args.peakAnchorIso ? Date.parse(args.peakAnchorIso) : NaN;

  if (highEnough && clearEnough && Number.isFinite(anchorMs)) {
    const CAP_MS = 30 * 60_000;
    const rawDelta = anchorMs - eventMs;
    const delta = clamp(rawDelta, -CAP_MS, CAP_MS);
    return {
      iso: new Date(eventMs + delta).toISOString(),
      minutesFromEvent: Math.round(delta / 60_000),
    };
  }
  // Otherwise peak is at the event itself.
  return { iso: new Date(eventMs).toISOString(), minutesFromEvent: 0 };
}

/**
 * Where `now` falls within a sun event's golden-hour window, 0-100. Returns
 * null when `now` is outside the window (before it starts or after it ends)
 * — callers use that to decide "show the live progress bar" vs. "show the
 * upcoming times" per the card's spec.
 */
export function goldenHourProgress(now: Date, event: SunEventTime): number | null {
  const nowMs = now.getTime();
  const startMs = Date.parse(event.goldenStartIso);
  const endMs = Date.parse(event.goldenEndIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  if (nowMs < startMs || nowMs > endMs) return null;
  return Math.min(100, Math.max(0, ((nowMs - startMs) / (endMs - startMs)) * 100));
}

// --- hourly lookup -------------------------------------------------------------

/** One hourly forecast point's cloud + humidity reading, keyed by time. Shaped
 *  loosely (structural typing) so a real `HourlyMetrics` row — which today only
 *  carries `cloudCoverPct`/`humidityPct` — can be mapped in with one line:
 *  `{ time: h.time, cloud: { totalPct: h.cloudCoverPct }, humidityPct: h.humidityPct }`. */
export interface HourlyCloudPoint {
  /** ISO time (UTC) this reading is for. */
  time: string;
  cloud: CloudMix;
  humidityPct?: number;
}

/**
 * The hourly point closest to an event's time, within `toleranceMinutes`
 * (default 90 — comfortably more than half the 1-hour forecast cadence, so a
 * sun event that falls mid-hour still matches). Returns undefined when there's
 * no point within tolerance, so callers can honest-null rather than guess.
 */
export function nearestHourlyPoint(
  eventTimeIso: string,
  points: readonly HourlyCloudPoint[],
  toleranceMinutes = 90,
): HourlyCloudPoint | undefined {
  const eventMs = Date.parse(eventTimeIso);
  if (!Number.isFinite(eventMs) || points.length === 0) return undefined;

  let best: HourlyCloudPoint | undefined;
  let bestDiffMs = Infinity;
  for (const p of points) {
    const t = Date.parse(p.time);
    if (!Number.isFinite(t)) continue;
    const diff = Math.abs(t - eventMs);
    if (diff < bestDiffMs) {
      bestDiffMs = diff;
      best = p;
    }
  }
  if (!best || bestDiffMs > toleranceMinutes * 60000) return undefined;
  return best;
}

// ---------------------------------------------------------------------------
// INTEGRATION NOTE (updated). Cloud-by-level IS now fetched:
// lib/sources/hourlyForecast.ts requests cloud_cover_low/mid/high and threads
// them onto HourlyMetrics, so the complete level split reaches sunEventQuality
// through the card's `sunQualityHourly` map — the level-based path is the norm,
// with the flatter total-only curve remaining the honest fallback.
//
// The richer FACTOR model (clearPath + canvas + prior × aerosol/humidity
// modifiers) engages when the level split is joined by at least one atmospheric
// or satellite signal:
//   - AEROSOL: lib/sources/airQuality.ts now also fetches CAMS
//     `aerosol_optical_depth` (+ PM2.5, already fetched) — a CURRENT reading,
//     applied as a small ±modifier (slowly varying, so acceptable for near-term
//     events; honestly labeled "air clarity (now)").
//   - HORIZON / CLEAR-PATH: GOES beam-path cloud (lib/sources/goesCloud.ts's
//     `beamCloudPct`) is a live "right now" observation, so the card passes it
//     as `horizon` with `fresh:true` ONLY when the granule is current AND the
//     event is imminent; otherwise clearPath degrades to a low-cloud estimate.
//   - PRESSURE / post-frontal bonus: NOT wired — HourlyMetrics carries no
//     surface-pressure field (only dew point), so per the spec that factor is
//     skipped rather than adding a new fetch. Re-add if pressure is ever fetched.
// ---------------------------------------------------------------------------
