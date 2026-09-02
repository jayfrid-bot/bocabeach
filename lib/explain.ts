// Plain-English explainer for the Beach Day score. Translates the technical
// sub-scores into one-line "what's helping / what's hurting" readings a
// non-engineer can scan in two seconds. Pure given its inputs — UI-free.

import { DEFAULT_SCORING, type Derived } from "@/lib/score";
import type { ScoreResult, ScoringOptions, SubKey, WaveMode } from "@/lib/types";
import { seaState } from "@/lib/format";
import { sandVerdict } from "@/lib/sandTemp";

export interface Reason {
  emoji: string;
  text: string;
}
export interface ScoreExplanation {
  /** A one-liner that frames the rest. */
  summary: string;
  helping: Reason[];
  hurting: Reason[];
}

// Score thresholds for inclusion. Middling sub-scores (55-74) are noise and
// would dilute the message, so we drop them.
const HELP_AT = 75;
const HURT_AT = 55;

function r(emoji: string, text: string): Reason {
  return { emoji, text };
}

/** Categorize each available sub-score and write its one-line plain-English read. */
function reasonsFor(d: Derived, result: ScoreResult): {
  helping: Reason[];
  hurting: Reason[];
} {
  const helping: Reason[] = [];
  const hurting: Reason[] = [];
  const by = new Map(result.subScores.map((s) => [s.key, s]));
  // Sub-scores whose category is already explained by a hard cap — skip the
  // duplicate sub-score reason so the user doesn't see the same thing twice.
  const capCovers = new Set<string>();
  for (const c of result.caps) {
    const lc = c.toLowerCase();
    if (/seaweed|sargassum/.test(lc)) capCovers.add("sargassum");
    if (/thunder|storm|rain/.test(lc)) capCovers.add("sky");
    // Match only the water-quality caps ("Water quality advisory…", "…no-swim
    // advisory…") — NOT a bare "advisory", which would also catch the unrelated
    // surf/coastal-flood advisory cap and wrongly suppress a real poor-water
    // reason (the two are independent signals).
    if (/water quality|no.?swim/.test(lc)) capCovers.add("waterQuality");
  }
  const push = (key: string, helpText: string, hurtText: string, hurtEmoji?: string, helpEmoji?: string) => {
    const s = by.get(key);
    if (!s || s.score == null) return;
    if (s.score >= HELP_AT && helpText) helping.push(r(helpEmoji ?? defaults[key].help, helpText));
    else if (s.score < HURT_AT && hurtText && !capCovers.has(key))
      hurting.push(r(hurtEmoji ?? defaults[key].hurt, hurtText));
  };
  const defaults: Record<string, { help: string; hurt: string }> = {
    airTemp: { help: "🌡️", hurt: "🌡️" },
    sky: { help: "☀️", hurt: "☁️" },
    wind: { help: "💨", hurt: "💨" },
    comfort: { help: "💧", hurt: "💧" },
    waterTemp: { help: "🌊", hurt: "🥶" },
    waves: { help: "🌊", hurt: "🌊" },
    waterQuality: { help: "🧫", hurt: "🧫" },
    sargassum: { help: "🏖️", hurt: "🪸" },
    crowds: { help: "🧘", hurt: "👥" },
    uv: { help: "🧴", hurt: "🧴" },
    sandTemp: { help: "🦶", hurt: "🦶" },
    clarity: { help: "🥽", hurt: "🌫️" },
  };

  // Air temp — "feels great" vs "cold/hot".
  const air = d.airTempF;
  if (air != null) {
    push(
      "airTemp",
      `Air feels great at ${air}°F`,
      air < 70 ? `Air is chilly at ${air}°F` : `Air is hot at ${air}°F`,
    );
  }

  // Sky — clear vs rain/overcast.
  {
    const f = d.shortForecast?.toLowerCase() ?? "";
    const cloudy = d.cloudCoverPct != null && d.cloudCoverPct > 60;
    const rainy = /rain|shower|drizzle|thunder|storm/.test(f);
    // Fallback when the low sky score isn't from forecast-text rain or heavy
    // cloud: surface whatever data actually dragged the score down. A low sky
    // score with thin cloud is precip-driven, so lead with the rain chance;
    // otherwise describe the real cloud cover. Never claim "Mostly cloudy" on
    // a clear sky.
    const skyFallback =
      d.precipProbability != null && d.precipProbability >= 25
        ? `Rain is possible (${d.precipProbability}% chance)`
        : d.cloudCoverPct != null
          ? `Partly cloudy (${d.cloudCoverPct}% cloud)`
          : "Unsettled skies in the forecast";
    push(
      "sky",
      rainy ? "" : "Sunshine and no rain in the forecast",
      rainy
        ? `Wet weather in the forecast (${d.shortForecast})`
        : cloudy
          ? `Overcast skies (${d.cloudCoverPct}% cloud)`
          : skyFallback,
    );
  }

  // Wind — sweet-spot vs gusty/dead-calm.
  if (d.windSpeedMph != null) {
    const w = d.windSpeedMph;
    push(
      "wind",
      `A perfect ${w} mph sea breeze`,
      w < 3
        ? "Dead-still air — buggy and hot"
        : w >= 18
          ? `Strong ${w} mph wind — choppy and blowing sand`
          : `Brisk ${w} mph wind`,
    );
  }

  // Comfort — dew point.
  if (d.dewPointF != null) {
    const dp = d.dewPointF;
    push(
      "comfort",
      "Air feels dry and comfortable",
      dp >= 75
        ? `Air is oppressive and muggy (${dp}°F dew pt)`
        : `Air is sticky (${dp}°F dew pt)`,
    );
  }

  // Water temp.
  if (d.waterTempF != null) {
    const wt = d.waterTempF;
    push(
      "waterTemp",
      `Water is a swimmable ${wt}°F`,
      `Water is chilly at ${wt}°F`,
    );
  }

  // Waves — use seaState ladder.
  if (d.waveHeightFt != null) {
    const ss = seaState(d.waveHeightFt);
    push(
      "waves",
      `${ss.label} water (${d.waveHeightFt} ft) — ${ss.note}`,
      `${ss.label} seas (${d.waveHeightFt} ft) — ${ss.note}`,
    );
  }

  // Water quality is no longer a weighted factor (advisory-cap only), so it's
  // not a "helping/holding back" reason. An active advisory still surfaces as a
  // CAP reason via capReasons (capCovers.add("waterQuality") above).

  // Seaweed.
  {
    const lvl = d.sargassumLevel;
    const pct = d.sargassumCoveragePct;
    const detail = pct != null ? ` (~${pct}% coverage)` : "";
    push(
      "sargassum",
      "Clean beach — no seaweed",
      lvl === "high"
        ? `Heavy seaweed mats along the shore${detail}`
        : lvl === "moderate"
          ? `Moderate seaweed on the beach${detail}`
          : `Some seaweed on the beach${detail}`,
    );
  }

  // Water clarity. Only a scored factor for profiles that asked for it
  // (snorkeling); with weight 0 the sub-score never reaches this map, so the
  // free score's explainer is unchanged.
  if (d.clarityPct != null) {
    push(
      "clarity",
      `Water looks clear (~${d.clarityPct}% clarity)`,
      `Water is murky (~${d.clarityPct}% clarity)`,
    );
  }

  // Crowds.
  if (d.crowdPct != null) {
    push(
      "crowds",
      "Beach is quiet right now",
      d.crowdPct >= 80
        ? `Beach is packed (~${d.crowdPct}% full)`
        : `Beach is busy (~${d.crowdPct}% full)`,
    );
  }

  // UV — read straight off the raw index per EPA bands, NOT the sky-style
  // score-band push helper (routing through the inverted/clamped uv sub-score
  // made "extreme" copy unreachable and "manageable" fire for very-high UV).
  // We only list UV as a score *driver* at the extremes: manageable (<=7) helps,
  // extreme (11+) hurts. The middle "very high" band (8-10) keeps the uv
  // sub-score bar healthy (76-100), so flagging it as "holding it back" would
  // contradict the gauge — the dedicated UV card already shows the index and
  // burn time for that range, so the explainer stays quiet here.
  if (d.uvIndex != null) {
    const uv = d.uvIndex;
    if (uv <= 7) {
      helping.push(r(defaults.uv.help, `UV is manageable (index ${uv})`));
    } else if (uv >= 11) {
      hurting.push(r(defaults.uv.hurt, `UV is extreme (${uv}) — heavy sunscreen, cover up`));
    }
  }

  // Sand temp — use the verdict bands directly. "Warm" sand (95-114°F) scores
  // high enough to land in the help branch, so the help copy has to track the
  // verdict label too — only true "Barefoot fine" sand is comfortable barefoot.
  if (d.sandTempF != null) {
    const v = sandVerdict(d.sandTempF);
    push(
      "sandTemp",
      v.label === "Barefoot fine"
        ? `Sand is comfortable barefoot (~${d.sandTempF}°F)`
        : `Sand is warm (~${d.sandTempF}°F) — quick barefoot walks OK`,
      v.label === "Scorching"
        ? `Sand is scorching (~${d.sandTempF}°F) — wear shoes, real burn risk`
        : `Sand is hot (~${d.sandTempF}°F) — sandals recommended`,
    );
  }

  return { helping, hurting };
}

/** Hard caps (lifeguard flags, storms, advisories) shown front-and-center. */
function capReasons(result: ScoreResult): Reason[] {
  return result.caps.map((c): Reason => {
    const lower = c.toLowerCase();
    if (lower.includes("seaweed") || lower.includes("sargassum")) return r("🪸", c);
    if (lower.includes("lightning")) return r("⚡", c);
    if (lower.includes("thunder")) return r("⛈️", c);
    if (lower.includes("raining")) return r("🌧️", c);
    if (lower.includes("rain")) return r("🌧️", c);
    if (lower.includes("flag") || lower.includes("closed")) return r("🚩", c);
    if (lower.includes("advisory") || lower.includes("no swim")) return r("🚫", c);
    if (lower.includes("severe") || lower.includes("warning")) return r("⚠️", c);
    return r("⚠️", c);
  });
}

/** The free score's summary. Unchanged, and shown to every free user. */
const DEFAULT_SUMMARY =
  "We add points for sunshine, warm air, a sea breeze, dry feel, warm water, calm seas, an empty beach, and manageable UV. We take them away for rain, scorching sand, choppy seas, high wind, heavy seaweed, lifeguard flags, and severe weather — and a water-quality advisory hard-caps the whole score.";

/** How each factor reads inside "… and … lead." */
const LEAD_PHRASE: Record<SubKey, string> = {
  airTemp: "warm air",
  sky: "sunshine",
  wind: "a light sea breeze",
  comfort: "dry air",
  waterTemp: "warm water",
  waves: "calm water",
  sargassum: "a clean beach",
  crowds: "an empty beach",
  uv: "manageable UV",
  sandTemp: "cool sand",
  clarity: "water clarity",
};

/** The order the engine lists factors in — the tie-break when weights match. */
const FACTOR_ORDER = Object.keys(DEFAULT_SCORING.weights) as SubKey[];

function leadPhrase(key: SubKey, waveMode: WaveMode): string {
  if (key === "waves") {
    if (waveMode === "surf") return "rideable surf";
    if (waveMode === "some") return "a bit of swell";
  }
  return LEAD_PHRASE[key];
}

/** True when these options are the free score's — the summary then never changes. */
function isDefaultWeights(opts: ScoringOptions): boolean {
  return FACTOR_ORDER.every((k) => opts.weights[k] === DEFAULT_SCORING.weights[k]);
}

/** What the caps sentence says depends on which caps this person's score obeys. */
function capsSentence(opts: ScoringOptions): string {
  if (opts.capPolicy === "shore") {
    return "Storms, high wind, and heavy seaweed still cap it; flags and rip currents stay in the safety line.";
  }
  if (opts.capPolicy === "surf") {
    return "Storms and closures still cap it; a red flag or a high rip is information, not a stop sign.";
  }
  return "Storms, high wind, heavy seaweed, flags, and advisories still cap it.";
}

/** The one-liner that frames the breakdown, in this person's terms. */
function summaryFor(opts: ScoringOptions, label?: string): string {
  if (!label && isDefaultWeights(opts)) return DEFAULT_SUMMARY;
  const top = FACTOR_ORDER.filter((k) => opts.weights[k] > 0)
    .map((k, i) => ({ k, i, w: opts.weights[k] }))
    .sort((a, b) => b.w - a.w || a.i - b.i)
    .slice(0, 2)
    .map((x) => leadPhrase(x.k, opts.ideals.waveMode));
  if (!top.length) return DEFAULT_SUMMARY;
  const lead = top.length === 2 ? `${top[0]} and ${top[1]}` : top[0];
  const head = label ? `Tuned for ${label}: ${lead} lead.` : `${lead} lead this score.`;
  return `${head} ${capsSentence(opts)}`;
}

/**
 * Produce the human-readable explanation. Pure + unit-testable.
 *
 * `opts` is the scoring the result was produced with, and `profileLabel` the
 * phrase from lib/profile/resolve.ts ("snorkeling"). With neither — the free
 * score — the summary is word-for-word what it has always been.
 */
export function explainScore(
  d: Derived,
  result: ScoreResult,
  opts: ScoringOptions = DEFAULT_SCORING,
  profileLabel?: string,
): ScoreExplanation {
  const { helping, hurting } = reasonsFor(d, result);
  const caps = capReasons(result);
  return {
    summary: summaryFor(opts, profileLabel),
    helping,
    // Caps come first — they're the most important reasons the score is what it is.
    hurting: [...caps, ...hurting],
  };
}
