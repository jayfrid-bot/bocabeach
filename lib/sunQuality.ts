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

export interface SunEventQualityInput {
  /** Cloud reading at the event hour. `undefined` (or every field unset) means
   *  "we don't have a forecast for that hour" → honest-null result. */
  cloud: CloudMix | undefined;
  /** Relative humidity at the event hour, 0-100. Optional small bonus only. */
  humidityPct?: number;
}

export interface SunEventQuality {
  /** 0-100, or null when there's no forecast cloud reading for the event hour. */
  score: number | null;
  /** null exactly when score is null. */
  band: SunQualityBand | null;
  /** One-line, plain-English explanation of the score. */
  note: string;
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

export interface SunEventTime {
  event: SunEventKind;
  /** ISO time of the event. */
  timeIso: string;
}

/**
 * Which sun event the card should show next: today's sunrise if it hasn't
 * happened yet, else today's sunset if that hasn't happened yet, else
 * tomorrow's sunrise. Pure — `now` is injected so it's testable without
 * mocking the clock. Returns null (honest-null) only when there's truly
 * nothing to show (no sun times at all, e.g. a fetch failure with no
 * tomorrow fallback supplied).
 */
export function nextSunEvent(
  now: Date,
  today: { sunrise?: string; sunset?: string },
  tomorrowSunriseIso?: string,
): SunEventTime | null {
  const nowMs = now.getTime();

  const sunriseMs = today.sunrise ? Date.parse(today.sunrise) : NaN;
  if (Number.isFinite(sunriseMs) && nowMs < sunriseMs) {
    return { event: "sunrise", timeIso: today.sunrise! };
  }

  const sunsetMs = today.sunset ? Date.parse(today.sunset) : NaN;
  if (Number.isFinite(sunsetMs) && nowMs < sunsetMs) {
    return { event: "sunset", timeIso: today.sunset! };
  }

  if (tomorrowSunriseIso) {
    return { event: "sunrise", timeIso: tomorrowSunriseIso };
  }

  return null;
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
// INTEGRATION NOTE for whoever wires this into ConditionsDashboard /
// ConditionsSnapshot — see the end-of-task report for the full write-up. Short
// version: cloud-by-level is NOT currently fetched (lib/sources/hourlyForecast.ts
// only requests Open-Meteo's `cloud_cover` total); every real call today will
// go through the `hasTotalOnly` path until `cloud_cover_low,cloud_cover_mid,
// cloud_cover_high` are added to that hourly URL and threaded onto
// HourlyMetrics. GOES beam-path cloud (lib/sources/goesCloud.ts's
// `beamCloudPct`) is a live "right now" observation, not a future-hour
// forecast, so it's not wired into `sunEventQuality` here — it's a candidate
// for a same-hour override/corroboration when the event is imminent (see the
// note for the exact idea + azimuth caveat).
// ---------------------------------------------------------------------------
