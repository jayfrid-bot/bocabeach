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
  | "traffic";

export interface NerdInfo {
  /** Card title, e.g. "Water temperature". */
  title: string;
  /** Its % weight in the composite Beach Day score, or null for a card that
   *  doesn't carry its own weighted sub-score (feeds another factor / is a
   *  safety cap / is purely informational). */
  weightPct: number | null;
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
      formula: "Informational only — traffic does NOT feed the Beach Day score.",
      computation,
      sources: src(snap.traffic.source),
      notes:
        "Shown so you can time the drive, deliberately kept out of the score — a packed road doesn't change how nice the beach itself is once you're there.",
    };
  },
};

/** Build the data-nerd breakdown for one card key from the live dashboard values. */
export function buildNerdInfo(key: NerdKey, ctx: NerdContext): NerdInfo {
  return nerdBuilders[key](ctx);
}

export { nerdBuilders };
