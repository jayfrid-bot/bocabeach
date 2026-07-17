// ---------------------------------------------------------------------------
// "Data nerd" registry — the math, metrics, and sources behind every dashboard
// card, for the flip-card backs. Each builder takes the LIVE dashboard values
// (the already-derived metrics `d` plus the raw `snapshot`) and returns a
// display-ready breakdown: the REAL curve + constants from lib/score.ts, this
// moment's numbers plugged in, the honest source attributions (pulled live from
// each source's own `.source` label so the per-beach specifics — buoy id, DOH
// county — stay accurate), and any caveats worth being upfront about.
//
// IMPORTANT: the formulas/constants below are transcribed verbatim from
// lib/score.ts (scoreBeachDay + its curve helpers) and lib/sandTemp.ts. If a
// weight or curve changes there, change it here too — lib/nerdInfo.test.ts pins
// a few of them so a silent drift fails the suite.
// ---------------------------------------------------------------------------

import type { ConditionsSnapshot } from "@/lib/types";
import type { Derived } from "@/lib/score";
import { currentHourOf, satelliteBeamCloudPct, satelliteCloudPct } from "@/lib/score";
import { afternoonBoostFactor, hoursFromSolarNoon } from "@/lib/sandTemp";
import { computeStormActivity } from "@/lib/stormActivity";
import { clamp, degToCardinal, plateau } from "@/lib/util";

export type NerdKey =
  | "wind"
  | "waves"
  | "uv"
  | "busyness"
  | "airTemp"
  | "waterTemp"
  | "humidity"
  | "dewPoint"
  | "cloudCover"
  | "rainChance"
  | "waterQuality"
  | "ripCurrent"
  | "seaweed"
  | "traffic"
  | "sandTemp"
  | "storm"
  | "lightning";

export interface NerdInfo {
  /** Card title, e.g. "Water temperature". */
  title: string;
  /** Its % weight in the composite Beach Day score, or null for a card that
   *  doesn't carry its own weighted sub-score (feeds another factor / is a
   *  safety cap / is purely informational). */
  weightPct: number | null;
  /** Plain-English lead: what this number actually is, where it truly comes
   *  from, and why it matters on the beach — clearer than the terse `notes`.
   *  Rendered at the TOP of the flip-card back (above "Right now"). */
  explainer: string;
  /** The real curve with the real constants (from lib/score.ts). */
  formula: string;
  /** 2-4 short lines showing THIS moment's numbers plugged in. */
  computation: string[];
  /** The real source attributions (pulled live from the snapshot's `.source`). */
  sources: string[];
  /** Honest caveats — calibration limits, gates, what "feeds" what. */
  notes?: string;
}

export interface NerdContext {
  d: Derived;
  snap: ConditionsSnapshot;
}

// --- Sub-score WEIGHTS, transcribed from scoreBeachDay() in lib/score.ts -----
// (kept as whole-percent ints for display; the source uses the 0-1 fractions.)
export const SCORE_WEIGHTS_PCT = {
  airTemp: 16,
  sky: 16,
  wind: 13,
  comfort: 8,
  waterTemp: 9,
  waves: 8,
  waterQuality: 6,
  sargassum: 7,
  crowds: 5,
  uv: 4,
  sandTemp: 8,
} as const;

// --- Curve anchors, transcribed from lib/score.ts ----------------------------
const SEAWEED_COVER_CURVE: [number, number][] = [
  [0, 100],
  [10, 85],
  [30, 55],
  [60, 20],
  [100, 0],
];
const SARGASSUM_SCORE: Record<string, number> = { none: 100, low: 85, moderate: 55, high: 20 };
const CROWD_CURVE: [number, number][] = [
  [0, 100],
  [25, 90],
  [50, 70],
  [75, 45],
  [100, 25],
];

/** Piecewise-linear interpolation — same shape as lib/score.ts's `lerpCurve`. */
function lerpCurve(x: number, anchors: [number, number][]): number {
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

const r0 = (n: number) => Math.round(n);
/** "sub × pct% = Y.y pts" — a sub-score's weighted contribution to the composite. */
function pts(sub: number, pct: number): string {
  return `${r0(sub)} × ${pct}% = ${((r0(sub) * pct) / 100).toFixed(1)} pts`;
}
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
/** Only-non-empty source lines. */
const src = (...lines: (string | undefined | null)[]): string[] =>
  lines.filter((l): l is string => !!l);

const CONSENSUS_NOTE = "consensus median so no single provider skews the number";

// --- builders ---------------------------------------------------------------

const nerdBuilders: Record<NerdKey, (ctx: NerdContext) => NerdInfo> = {
  wind: ({ d, snap }) => {
    const mph = d.windSpeedMph;
    const dir = d.windDirDeg;
    const computation =
      mph != null
        ? (() => {
            const s = r0(plateau(mph, 5, 13, 12));
            return [
              `${mph} mph${dir != null ? ` from ${degToCardinal(dir)}` : ""} → windScore ${s}/100`,
              pts(s, SCORE_WEIGHTS_PCT.wind),
            ];
          })()
        : ["No wind reading — this factor is dropped from the weighted average."];
    return {
      title: "Wind",
      weightPct: SCORE_WEIGHTS_PCT.wind,
      explainer:
        "Wind can make or break a beach day, so it's one of the heavier factors. A light sea breeze — roughly 5–13 mph — is the sweet spot: enough to take the edge off the heat and keep the bugs down, without kicking up sand or chop. Dead-calm air feels hot and buggy, and a stiff 25 mph wind sandblasts your towel, so the score falls off on both sides of that window. The speed shown is a consensus median across four forecast models, so no single provider can skew it.",
      formula: "windScore = plateau(windMph, 5–13 mph = 100, then −100 over the next 12 mph on each side)",
      computation,
      sources: src(
        `Median of ${snap.weather.source} · ${snap.metno.source} · ${snap.hourly.source} · ${snap.gfs.source}`,
        `Fallback: ${snap.buoy.source}`,
      ),
      notes:
        "A light sea breeze is the sweet spot, not dead calm — glassy air (≈58) is buggy and hot, a ~25 mph gale (≈0) blows sand. Wind speed is the multi-source " +
        CONSENSUS_NOTE + "; direction is NWS/MET/buoy.",
    };
  },

  waves: ({ d, snap }) => {
    const ft = d.waveHeightFt;
    const computation =
      ft != null
        ? (() => {
            const s = r0(clamp(100 - Math.max(0, ft - 1) * 25, 0, 100));
            return [`${ft} ft → waveCalm ${s}/100`, pts(s, SCORE_WEIGHTS_PCT.waves)];
          })()
        : ["No wave reading — this factor is dropped from the weighted average."];
    return {
      title: "Sea state",
      weightPct: SCORE_WEIGHTS_PCT.waves,
      explainer:
        "This reads the ocean's roughness as a swimming-calmness proxy — how easy it is to wade in and float, not how good the surf is. Knee-high water (about a foot or less) scores a perfect 100; the score bleeds off as the combined wave-and-swell height climbs, hitting zero by roughly 5 ft of churn. It comes from the nearest NOAA buoy when one's reporting, and falls back to a marine model otherwise.",
      formula: "waveCalm = 100 − max(0, waveFt − 1) × 25  (≤1 ft = 100, hits 0 by 5 ft)",
      computation,
      sources: src(`${snap.buoy.source} (primary)`, `${snap.marine.source} (fallback)`),
      notes: "Combined sea state (wave + swell height) as a swimming-calmness proxy — not a surf-quality rating.",
    };
  },

  uv: ({ d, snap }) => {
    const uv = d.uvIndex;
    const computation =
      uv != null
        ? (() => {
            const s = r0(clamp(100 - Math.max(0, uv - 8) * 12, 0, 100));
            return [`UV ${uv} → uvScore ${s}/100`, pts(s, SCORE_WEIGHTS_PCT.uv)];
          })()
        : ["No UV reading — this factor is dropped from the weighted average."];
    return {
      title: "UV index",
      weightPct: SCORE_WEIGHTS_PCT.uv,
      explainer:
        "This is how strong the sun's burn potential is right now. Up to a UV of 8 it barely moves the score — you should be wearing sunscreen at the beach regardless — and only the more extreme readings above that pull it down. When the GOES-19 satellite sees a genuinely heavy cloud deck overhead we lower the shown UV, but never raise it, so a sneaky bright-overcast burn still warns you.",
      formula: "uvScore = 100 − max(0, UV − 8) × 12  (UV ≤8 = 100, hits 0 by UV ~16)",
      computation,
      sources: src(
        `${snap.hourly.source} — UV index`,
        `${snap.goesCloud.source} — heavy-deck attenuation`,
        `${snap.marine.source} (fallback)`,
      ),
      notes:
        "The shown UV is the forecast index, but LOWERED when the GOES-19 satellite sees a heavy deck (≥50%): clear-sky UV is scaled down linearly to a 0.4 floor at a 100% deck (we only ever lower, never raise, so a bright-overcast burn still warns). 'Minutes to burn' is a separate skin-safety readout, not part of the score.",
    };
  },

  busyness: ({ d, snap }) => {
    const pct = d.crowdPct;
    const computation =
      pct != null
        ? (() => {
            const s = r0(lerpCurve(pct, CROWD_CURVE));
            return [`~${pct}% full → crowdScore ${s}/100`, pts(s, SCORE_WEIGHTS_PCT.crowds)];
          })()
        : ["Cams can't read the beach right now — this factor is dropped from the average."];
    return {
      title: "Crowds",
      weightPct: SCORE_WEIGHTS_PCT.crowds,
      explainer:
        "How full the beach looks right now, read straight off the public beach cams by a vision model. An empty beach scores best and a packed one worst — this is about elbow room, not safety. At night, or when a cam is down or stale, we simply can't see the sand, so busyness reads 'unknown' and drops out of the score entirely rather than pretending the beach is empty.",
      formula: "crowdScore = curve through 0%→100, 25%→90, 50%→70, 75%→45, 100%→25 (emptier is better)",
      computation,
      sources: src(snap.busyness.source),
      notes:
        "Read from the beach cams by a vision model (busiest cam now, else the hour's learned average). Night gate: when the cams can't see the beach (dark or a stale capture) busyness reads 'unknown' and is dropped entirely rather than faking an empty beach.",
    };
  },

  airTemp: ({ d, snap }) => {
    const t = d.airTempF;
    const computation =
      t != null
        ? (() => {
            const s = r0(plateau(t, 78, 88, 18));
            return [`${t}°F → airTemp ${s}/100`, pts(s, SCORE_WEIGHTS_PCT.airTemp)];
          })()
        : ["No air-temp reading — this factor is dropped from the weighted average."];
    return {
      title: "Air temp",
      weightPct: SCORE_WEIGHTS_PCT.airTemp,
      explainer:
        "Plain old air temperature — and the single heaviest ingredient in the Beach Day score (tied with Sky). The comfortable band is 78–88°F: warm enough for the water, not so hot that the sand and sun turn punishing. The score slides off steadily above or below that band. The number is a consensus median across four weather models, so one bad station can't throw it off.",
      formula: "plateau(airTempF, 78–88°F = 100, then −100 over 18°F on each side)",
      computation,
      sources: src(
        `Median of ${snap.weather.source} · ${snap.metno.source} · ${snap.hourly.source} · ${snap.gfs.source}`,
        `Fallback: ${snap.buoy.source}`,
      ),
      notes: `The single heaviest factor (tied with Sky at 16%). ${cap(CONSENSUS_NOTE)}.`,
    };
  },

  waterTemp: ({ d, snap }) => {
    const t = d.waterTempF;
    const computation =
      t != null
        ? (() => {
            const s = r0(plateau(t, 77, 90, 15));
            return [`${t}°F → waterTemp ${s}/100`, pts(s, SCORE_WEIGHTS_PCT.waterTemp)];
          })()
        : ["No water-temp reading — this factor is dropped from the weighted average."];
    return {
      title: "Water temp",
      weightPct: SCORE_WEIGHTS_PCT.waterTemp,
      explainer:
        "How warm the ocean is for a swim. Warmer is simply better for a beachgoer, all the way up to about 90°F — only past that does bathwater-warm ocean start to feel like soup (and hint at coral stress and a weaker cool-off). It's read from the nearest NOAA buoy when one's live, and falls back to a sea-surface model otherwise.",
      formula: "plateau(waterTempF, 77–90°F = 100, then −100 over 15°F on each side)",
      computation,
      sources: src(`${snap.buoy.source} (primary)`, `${snap.marine.source} sea-surface (fallback)`),
      notes:
        "Warmer is better for a beachgoer right up to ~90°F; only past 90 does warm ocean start reading as 'soup' (and it tracks coral-bleaching / weaker cooling-off value).",
    };
  },

  humidity: ({ d, snap }) => {
    const rh = d.humidityPct;
    const computation =
      rh != null
        ? [
            `${rh}% relative humidity`,
            rh > 85
              ? `>85% → adds a Comfort penalty of −${((rh - 85) * 1.5).toFixed(1)}`
              : "≤85% → no extra Comfort penalty",
          ]
        : ["No humidity reading."];
    return {
      title: "Humidity",
      weightPct: null,
      explainer:
        "Relative humidity on its own doesn't score — it feeds the Comfort factor through dew point, which is the truer 'how heavy is the air' gauge. Very muggy air above 85% does tack on a small extra Comfort penalty, since sweat can't evaporate to cool you. It's also the backup input for dew point whenever no source reports dew point directly.",
      formula: "Not scored directly — feeds Comfort (dew point). Very high RH (>85%) subtracts (RH − 85) × 1.5 from Comfort.",
      computation,
      sources: src(
        `Median of ${snap.weather.source} · ${snap.metno.source} · ${snap.hourly.source} · ${snap.gfs.source}`,
      ),
      notes:
        "Also the fallback input for dew point: when no source reports dew point directly, it's derived from the consensus air temp + this humidity (Magnus-Tetens).",
    };
  },

  dewPoint: ({ d, snap }) => {
    const dew = d.dewPointF;
    const rh = d.humidityPct;
    const computation =
      dew != null
        ? (() => {
            const base = clamp(100 - Math.max(0, dew - 60) * 5, 0, 100);
            const s = rh != null && rh > 85 ? clamp(base - (rh - 85) * 1.5, 0, 100) : base;
            const lines = [`${dew}°F dew pt → base ${r0(base)}/100`];
            if (rh != null && rh > 85) lines.push(`RH ${rh}% >85 → ${r0(s)}/100`);
            lines.push(pts(s, SCORE_WEIGHTS_PCT.comfort));
            return lines;
          })()
        : ["No dew point — this factor is dropped from the weighted average."];
    return {
      title: "Comfort",
      weightPct: SCORE_WEIGHTS_PCT.comfort,
      explainer:
        "Dew point, not raw humidity, is what actually tells you how oppressive the air feels — the higher it climbs, the less your sweat can evaporate to cool you. Below 60°F is crisp and comfortable (a perfect Comfort score); by the upper 70s the air feels like a wet blanket and Comfort bottoms out. Extremely humid air piles on a further penalty on top of that.",
      formula: "comfortScore = 100 − max(0, dewPointF − 60) × 5  (≤60°F=100; 68→60, 72→40, ≥80→0), then −(RH−85)×1.5 if RH>85",
      computation,
      sources: src(
        `Median of ${snap.weather.source} · ${snap.metno.source} · ${snap.hourly.source} · ${snap.gfs.source}`,
        "Fallback: derived from consensus air temp + RH (Magnus-Tetens)",
      ),
      notes: "Dew point, not raw humidity, is the real 'how heavy does the air feel' driver — sweat can't evaporate as it climbs.",
    };
  },

  cloudCover: ({ d, snap }) => {
    const cloud = d.cloudCoverPct;
    const computation =
      cloud != null
        ? (() => {
            const sun = r0(clamp(100 - cloud, 0, 100));
            return [`${cloud}% cloud → sunshine ${sun}/100`, "weighted 0.6 into the Sky sub-score"];
          })()
        : ["No cloud reading."];
    return {
      title: "Cloud cover",
      weightPct: null,
      explainer:
        "How much of the sky is covered, which feeds the Sky factor alongside rain chance — more sun means a better beach day. This card shows the multi-source consensus. Separately, a dedicated GOES-19 satellite reading of the actual clouds drives the sand-temperature model and, when it's genuinely overcast, tempers the UV — those two use the satellite, not this consensus number.",
      formula: "Feeds Sky (16% of score). skyBase = 0.6 × sunshine + 0.4 × dryness, where sunshine = 100 − cloud%.",
      computation,
      sources: src(
        `Median of ${snap.marine.source} · ${snap.metno.source} · ${snap.hourly.source} · ${snap.weather.source} · ${snap.gfs.source}`,
        `${snap.goesCloud.source} — feeds the sand model + UV attenuation separately`,
      ),
      notes:
        "This card shows the multi-source consensus median (the Sky number). A separate GOES-19 satellite reading drives the sand-temp model and, at ≥50% observed, the UV attenuation. Cloud ≥50% also helps corroborate 'is it really raining' before rain is allowed to cap the day.",
    };
  },

  rainChance: ({ d, snap }) => {
    const p = d.precipProbability;
    const computation =
      p != null
        ? (() => {
            const dry = r0(clamp(100 - p, 0, 100));
            return [`${p}% rain chance → dryness ${dry}/100`, "weighted 0.4 into the Sky sub-score"];
          })()
        : ["No rain-chance reading."];
    return {
      title: "Rain chance",
      weightPct: null,
      explainer:
        "The forecast probability of rain, which feeds the Sky factor — a drier forecast lifts the score. Crucially, a mere chance of rain never caps your day: only actual, corroborated rain (a real rain code or a live nowcast) pulls the score down hard, and a thunderstorm harder still. That keeps a 30%-chance afternoon from reading like a washout.",
      formula: "Feeds Sky (16%): dryness = 100 − rain%, weighted 0.4 into skyBase. Rain only CAPS the score when coded/observed.",
      computation,
      sources: src(`${snap.weather.source} — precip probability`, `${snap.hourly.source} (fallback)`),
      notes:
        "A mere CHANCE of rain never caps the day — it only feeds Sky. An actual corroborated rain code (probability ≥25%) or an observed nowcast caps the score at 25; a thunderstorm caps it at 15.",
    };
  },

  waterQuality: ({ d, snap }) => {
    const rating = d.waterRating;
    const map: Record<string, number> = { good: 100, moderate: 60, poor: 0 };
    const computation =
      rating in map
        ? [`${cap(rating)} → ${map[rating]}/100`, pts(map[rating], SCORE_WEIGHTS_PCT.waterQuality)]
        : ["No recent sample — this factor is dropped from the weighted average."];
    return {
      title: "Water quality",
      weightPct: SCORE_WEIGHTS_PCT.waterQuality,
      explainer:
        "This is the county's weekly enterococci bacteria test of the water — the real 'is it safe to swim' signal, not an estimate. Good water scores full marks, poor water zero, and a moderate sample lands in between. An active health advisory doesn't just lower this factor; it hard-caps the entire Beach Day score at 40, no matter how nice everything else is.",
      formula: "good = 100, moderate = 60, poor = 0  (unknown → dropped from the average)",
      computation,
      sources: src(snap.waterQuality.source),
      notes:
        "From the county's weekly enterococci bacteria sampling. An active advisory ALSO hard-caps the whole score at 40, regardless of everything else.",
    };
  },

  ripCurrent: ({ snap }) => {
    const rip = snap.nws.data?.ripCurrentRisk;
    const computation =
      rip === "high"
        ? ["High → whole score capped at 85"]
        : rip === "moderate"
          ? ["Moderate → whole score capped at 92"]
          : rip && rip !== "unknown"
            ? [`${cap(rip)} → no cap applied`]
            : ["No rip-risk reading — no cap applied."];
    return {
      title: "Rip current",
      weightPct: null,
      explainer:
        "Rip currents are the ocean's real hazard — fast, narrow channels of water that pull swimmers away from shore. This isn't a weighted factor but a safety ceiling: High risk caps the whole score at 85 and Moderate at 92, because you can still enjoy the sand even when the water is dangerous. It comes straight from the National Weather Service Surf Zone Forecast.",
      formula: "Not a weighted factor — a safety CAP. High rip risk caps the score at 85; moderate caps it at 92.",
      computation,
      sources: src(snap.nws.source),
      notes:
        "A swimmer-safety hazard, not a beach-day killer — you can still enjoy the sand — so it limits the ceiling rather than bottoming the score. From the NWS Surf Zone Forecast.",
    };
  },

  seaweed: ({ d, snap }) => {
    const pct = d.sargassumCoveragePct;
    const level = d.sargassumLevel;
    let computation: string[];
    if (pct != null) {
      const s = r0(lerpCurve(pct, SEAWEED_COVER_CURVE));
      computation = [`~${pct}% covered → sargassum ${s}/100`, pts(s, SCORE_WEIGHTS_PCT.sargassum)];
      if (pct >= 50) {
        const ceiling = pct >= 90 ? 70 : Math.round(100 - (pct - 50) * 0.75);
        computation.push(`≥50% covered → score ceiling ${ceiling}`);
      }
    } else if (level && level in SARGASSUM_SCORE) {
      const s = SARGASSUM_SCORE[level];
      computation = [`${cap(level)} → sargassum ${s}/100`, pts(s, SCORE_WEIGHTS_PCT.sargassum)];
    } else {
      computation = ["No cam read — this factor is dropped from the weighted average."];
    }
    return {
      title: "Seaweed",
      weightPct: SCORE_WEIGHTS_PCT.sargassum,
      explainer:
        "Sargassum is the brown seaweed that can pile up on Florida sand and make the water unpleasant to wade through. We read its coverage off the cams — preferring the early-morning shot, before the city's cleaning tractor runs — so the more covered the beach, the lower the score. A heavy mat (50% or more) also slides a ceiling onto the whole score, but never far enough to read as a full beach closure.",
      formula: "coverage curve 0%→100, 10%→85, 30%→55, 60%→20, 100%→0  (else category none/low/moderate/high = 100/85/55/20)",
      computation,
      sources: src(snap.sargassum.source),
      notes:
        "Read from the cams, preferring the early-morning shot (before the City's beach-cleaning tractor). ≥50% coverage also slides a score ceiling from 100 down to 70 (flat 70 at ≥90%), so a heavy mat can't read as a full beach closure.",
    };
  },

  traffic: ({ snap }) => {
    const t = snap.traffic.data;
    const computation = t
      ? [
          `${cap(t.level)}${t.congestion != null ? ` · ${t.congestion}% congestion` : ""} near the beach`,
          "congestion index = HERE jamFactor × 10",
        ]
      : ["No traffic reading."];
    return {
      title: "Traffic",
      weightPct: null,
      explainer:
        "How bad the drive to the beach looks right now, shown purely so you can time your trip. It deliberately does NOT feed the Beach Day score — a jammed road doesn't make the beach itself any less nice once you've parked and got your toes in the sand.",
      formula: "Informational only — traffic does NOT feed the Beach Day score.",
      computation,
      sources: src(snap.traffic.source),
      notes:
        "Shown so you can time the drive, deliberately kept out of the score — a packed road doesn't change how nice the beach itself is once you're there.",
    };
  },

  // --- Flagship instruments (the showpieces — longer backs) -----------------

  sandTemp: ({ d, snap }) => {
    // "Right now" — pull the same live pieces the panel/score use: the current
    // dry-sand estimate, the GOES cloud input actually feeding the model, and
    // the afternoon-decay multiplier for this moment.
    const sand = d.sandTempF;
    const beam = satelliteBeamCloudPct(snap);
    const overhead = satelliteCloudPct(snap);
    const cloudPct = beam ?? overhead;
    const lon = snap.location?.lon;
    const computation: string[] = [];
    if (sand != null) {
      computation.push(`~${sand}°F dry (dune-side) sand estimate right now`);
    } else {
      computation.push("No hourly model data — no sand estimate right now.");
    }
    if (cloudPct != null) {
      const ageMin = snap.goesCloud?.data?.granuleAgeMinutes;
      computation.push(
        `GOES-19 cloud input ${r0(cloudPct)}% ${beam != null ? "along the sun's beam path" : "overhead"}` +
          (ageMin != null ? ` (${r0(ageMin)} min-old granule)` : ""),
      );
    } else {
      computation.push("GOES-19 cloud feed not fresh — model falls back to the forecast cloud consensus.");
    }
    if (lon != null) {
      const hrs = hoursFromSolarNoon(lon, new Date());
      const factor = afternoonBoostFactor(hrs);
      const when =
        hrs >= 0 ? `${hrs.toFixed(1)} h past solar noon` : `${(-hrs).toFixed(1)} h before solar noon`;
      computation.push(`Afternoon-decay factor ×${factor.toFixed(2)} (${when})`);
    }
    return {
      title: "Sand temperature",
      weightPct: SCORE_WEIGHTS_PCT.sandTemp,
      explainer:
        "Nobody measures beach sand — except us. We took an infrared thermometer to the actual sand: 20+ real readings across 7 field sessions in June–July 2026, and the whole model is calibrated against them — midday estimates land within about ±2°F of what the IR gun reads. The estimate starts from the weather model's ground-surface temperature plus a dry-sand solar boost, because loose dry sand traps the sun's heat and runs far hotter than generic modeled ground. The cloud input isn't a forecast: it's NOAA's GOES-19 satellite Clear Sky Mask (2 km pixels, refreshed roughly every 5 minutes), and we sample it ALONG THE SUN'S BEAM PATH — stepping boxes toward the sun at h ÷ tan(elevation) — because when the sun is low the cloud that actually shades the sand sits kilometres away, not overhead. A thermal-memory afternoon decay (discovered in a 15-reading field session where the same ~42° sun elevation gave a +33°F boost at 9:54 AM but only +1°F at 5 PM) tapers the boost from 1.4 h to 4.4 h past solar noon, and the wetter, firmer sand down by the surf runs about 0.65× the dune boost — roughly 10°F cooler, measured.",
      formula:
        "sandF = soil + √(solar / 1000) × 55°F, then × wind-cooling × cloud-damp × afternoon-decay (up to 0.9 damp under full overcast; × 0.3 after recent rain). Surf-side sand = soil + 0.65 × that boost.",
      computation,
      sources: src(
        `${snap.hourly.source} — modeled ground temp (soil 0 cm) + solar radiation`,
        `${snap.goesCloud.source} — beam-path cloud damping (our own GOES-19 pipeline)`,
        "Owner's IR-thermometer ground truth — 20+ readings on Boca sand, 7 field sessions (Jun–Jul 2026)",
      ),
      notes:
        "Guidance only, not lab-grade — calibrated to 'is it comfortable barefoot'. The error skews to the safe, over-warn side: it warns about burns that aren't quite there rather than missing ones that are.",
    };
  },

  storm: ({ snap }) => {
    // Recompute the live gauge from the same inputs ConditionsDashboard uses.
    const currentHour = currentHourOf(snap.hourly.data ?? []);
    const storm = computeStormActivity({
      lightning: snap.lightning,
      precipIn: currentHour?.precipIn,
      weatherCode: currentHour?.weatherCode,
      precipProbability: currentHour?.precipProbability,
    });
    let computation: string[];
    if (storm) {
      const p = storm.parts;
      const parts = [
        p.strikes != null ? `strike energy ${r0(p.strikes)}` : null,
        p.proximity != null ? `proximity ${r0(p.proximity)}` : null,
        p.rain != null ? `rain ${r0(p.rain)}` : null,
      ].filter((x): x is string => !!x);
      computation = [`Storm Activity ${storm.score}/100 — ${storm.band}`];
      if (parts.length) computation.push(`Parts (each /100): ${parts.join(" · ")}`);
    } else {
      computation = [
        "No live storm signal — the lightning feed is down or stale and rain alone isn't enough, so the gauge stays hidden rather than reading a false 'Calm'.",
      ];
    }
    return {
      title: "Storm activity",
      weightPct: null,
      explainer:
        "Storm Activity is a single 0–100 read on how stormy it is within about 20 miles of the beach, blended from three signals. The biggest piece (45%) is recency-weighted strike energy: every GOES-detected lightning strike contributes e^(−age/12 min), so a fresh burst reads hot while old strikes quietly fade away. Another 35% is how close the nearest strike is — the 'how loud is the thunder' proxy — and the last 20% is current rain intensity, with a floor that kicks in when the forecast independently corroborates a thunderstorm. A fresh strike within 5 miles overrides all of it and floors the gauge at 90; and if the satellite feed is down or stale we show nothing at all, rather than a falsely reassuring 'Calm'.",
      formula:
        "storm = 0.45 × strikeEnergy + 0.35 × proximity + 0.20 × rain (weighted over whatever parts are available). strikeEnergy = Σ e^(−age_min / 12) within 20 mi; a fresh strike ≤ 5 mi floors the score at 90.",
      computation,
      sources: src(snap.lightning.source, `${snap.hourly.source} — current-hour rain`),
      notes:
        "Safety-adjacent, so it fails silent: a dropped or stale lightning feed hides the gauge instead of implying an all-clear.",
    };
  },

  lightning: ({ snap }) => {
    const L = snap.lightning.data;
    const win = L?.windowMinutes ?? 30;
    const stale = snap.lightning.status !== "ok";
    let computation: string[];
    if (!L) {
      computation = ["Lightning feed unavailable right now."];
    } else if (L.totalInArea === 0) {
      computation = [`No strikes within range in the last ${win} min — all clear.`];
    } else {
      const dir = L.nearestBearingDeg != null ? ` ${degToCardinal(L.nearestBearingDeg)}` : "";
      const age = L.nearestMinutesAgo != null ? ` · ${L.nearestMinutesAgo} min ago` : "";
      computation = [
        `Nearest strike ${L.nearestMi ?? "—"} mi${dir}${age}`,
        `Bands: ${L.within10mi} within 10 mi · ${L.within25mi} within 25 mi · ${L.within50mi} within 50 mi (last ${win} min)`,
      ];
    }
    if (L && stale) computation.push("Feed delayed — radar greyed out, never shown as 'all clear'.");
    return {
      title: "Lightning",
      weightPct: null,
      explainer:
        "Every strike here comes from NOAA's GOES-19 Geostationary Lightning Mapper — an optical sensor parked in orbit that watches the entire hemisphere for the flash of lightning and publishes 20-second granules. Our own pipeline (a GitHub Action) reads the raw netCDF straight from NOAA's public bucket and republishes a distilled national feed roughly every minute — about as close to real time as satellite lightning gets. For your beach we compute the true distance and compass bearing to every strike (great-circle haversine math); a fresh strike within 5 miles hard-caps the whole Beach Day score at 10 — the 'get out of the water' rule. The radar plots ONLY real positions (the nearest strike at its true bearing); the per-band numbers are honest strike totals, never invented dots, and a stale feed greys the radar out rather than implying calm.",
      formula:
        "Per strike: distance = haversine(beach, strike), bearing = initial great-circle bearing. Radar shows the nearest strike at its true bearing plus per-band strike counts (10 / 25 / 50 mi). A fresh strike ≤ 5 mi caps the Beach Day score at 10.",
      computation,
      sources: src(snap.lightning.source, "Own GLM pipeline — GitHub Action reads raw netCDF, republishes ~1×/min"),
      notes:
        "A safety display: an unknown or stale feed is greyed out, never allowed to look like 'clear'.",
    };
  },
};

/** Build the data-nerd breakdown for one card key from the live dashboard values. */
export function buildNerdInfo(key: NerdKey, ctx: NerdContext): NerdInfo {
  return nerdBuilders[key](ctx);
}

export { nerdBuilders };
