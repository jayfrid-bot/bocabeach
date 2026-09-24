"use client";

import { BAND_RANGE, type BandedRipRisk, type RipRiskCurve } from "@/lib/ripRiskCurve";
import type { RipNow } from "@/lib/ripRisk";
import { levelForModelProb } from "@/lib/ripRisk/resolve";
import { ripCopy } from "@/lib/ripRisk/copy";
import type { RipNwpsBeachSeries } from "@/lib/sources/ripNwps";
import type { NerdInfo } from "@/lib/nerdInfo";
import { FlipCard, NerdBack } from "@/components/FlipCard";
import { fmtTime, fmtTimeCompact } from "@/lib/format";

/** The lead line's source label — which source actually governs right now
 *  (see lib/ripRisk's resolveRipNow priority: alert > model > forecast >
 *  unknown). Lifeguard flags are deliberately NOT one of these — they stay a
 *  separate display elsewhere in the app. */
function sourceLabel(ripNow: RipNow | undefined): string | null {
  if (!ripNow) return null;
  switch (ripNow.source) {
    case "alert":
      return "NWS alert in effect";
    case "model":
      return "NOAA rip current model";
    case "forecast":
      return "NWS forecast";
    default:
      return null;
  }
}

/** "8 PM Wed" — the model run's local timestamp, for the "NOAA model run …"
 *  line. Short weekday + compact time, beach-local. */
function fmtRunLabel(iso: string, tz: string): string {
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(new Date(iso));
  return `${fmtTimeCompact(iso, tz)} ${weekday}`;
}

const MODEL_BAND_FILL: Record<BandedRipRisk, string> = {
  low: "#10b981",
  moderate: "#f59e0b",
  high: "#e11d48",
};

const BAND_LABEL: Record<BandedRipRisk, string> = {
  low: "Low",
  moderate: "Moderate",
  high: "High",
};

// Same amber/orange/rose "getting more serious" escalation MarineStingerCard,
// StormActivityMeter, and TidePanel already use elsewhere in the app.
const BAND_TEXT_CLASS: Record<BandedRipRisk, string> = {
  low: "text-emerald-600 dark:text-emerald-400",
  moderate: "text-amber-600 dark:text-amber-400",
  high: "text-rose-700 dark:text-rose-400",
};

const BAND_STROKE: Record<BandedRipRisk, string> = {
  low: "#10b981", // emerald-500
  moderate: "#f59e0b", // amber-500
  high: "#e11d48", // rose-600
};

const BAND_FILL_ID: Record<BandedRipRisk, string> = {
  low: "rip-risk-fill-low",
  moderate: "rip-risk-fill-moderate",
  high: "rip-risk-fill-high",
};

// Sparkline viewBox geometry — small and quiet, following TideCurve's inline-
// SVG convention (an M/L path sampled across the hours, gradient fill under
// the line). Coordinates rounded to 2 decimals so the server-rendered SVG and
// the client hydration pass agree exactly (same convention as TideCurve /
// WaveHeightCard / UvCard / ScoreWheel).
const W = 280;
const CURVE_H = 56;
/** Extra vertical room below the curve for the quiet hour-axis labels. */
const AXIS_H = 14;
const H = CURVE_H + AXIS_H;
const PX = 4;
const PT = 6;
const PB = 6;
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Evenly-spaced tick indices into an `n`-length array: first, last, and
 *  `count - 2` more spread between them (e.g. count=4 → first, ~1/3, ~2/3,
 *  last — "7a  11a  3p  7p"). Deterministic, dedupes for short arrays. */
function pickTickIndices(n: number, count = 4): number[] {
  if (n <= 0) return [];
  if (n <= count) return Array.from({ length: n }, (_, i) => i);
  const idxs = new Set<number>();
  for (let i = 0; i < count; i++) {
    idxs.add(Math.round((i * (n - 1)) / (count - 1)));
  }
  return Array.from(idxs).sort((a, b) => a - b);
}

/** Index of the last hour whose bucket start is at/before `nowMs`; falls back
 *  to the first hour when `nowMs` is before the whole window (e.g. pre-dawn
 *  preview). Same "current bucket" convention as lib/score.ts's anchor logic. */
function currentHourIndex(hours: { t: string }[], nowMs: number): number {
  let idx = 0;
  for (let i = 0; i < hours.length; i++) {
    if (Date.parse(hours[i].t) <= nowMs) idx = i;
    else break;
  }
  return idx;
}

/**
 * Small inline sparkline for the hourly curve. The Y-scale is anchored to the
 * OFFICIAL day-level's true band width (BAND_RANGE), not autoscaled to
 * today's actual min/max — a quiet, nearly-flat day should visibly look flat,
 * not get zoomed into a fake dramatic squiggle.
 */
function Sparkline({
  hours,
  band,
  nowMs,
  tz,
}: {
  hours: RipRiskCurve["hours"];
  band: BandedRipRisk;
  nowMs: number | null;
  /** IANA timezone the hour-axis labels are formatted in — the beach's own
   *  local time, not the viewer's, since the curve's hours are beach-local
   *  daylight buckets. */
  tz: string;
}) {
  if (hours.length < 2) return null;
  const { min, max } = BAND_RANGE[band];
  const span = Math.max(max - min, 1);

  const t0 = Date.parse(hours[0].t);
  const tN = Date.parse(hours[hours.length - 1].t);
  const spanT = Math.max(tN - t0, 1);
  const xFor = (t: number) => PX + ((t - t0) / spanT) * (W - 2 * PX);
  const yFor = (score: number) => PT + (1 - (score - min) / span) * (CURVE_H - PT - PB);

  const pts = hours.map((h) => ({ x: xFor(Date.parse(h.t)), y: yFor(h.score) }));
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${round2(p.x)} ${round2(p.y)}`).join(" ");
  const area = `${d} L${round2(pts[pts.length - 1].x)} ${CURVE_H - PB} L${round2(pts[0].x)} ${CURVE_H - PB} Z`;

  const stroke = BAND_STROKE[band];
  const fillId = BAND_FILL_ID[band];

  const nowVisible = nowMs != null && nowMs >= t0 && nowMs <= tN;
  const nowIdx = nowVisible ? currentHourIndex(hours, nowMs as number) : -1;
  const nowPt = nowIdx >= 0 ? pts[nowIdx] : null;
  // Keep the "now" tag from clipping off the top edge when the current hour's
  // point sits right near PT.
  const nowLabelY = nowPt ? round2(Math.max(8, nowPt.y - 7)) : null;

  const tickIdx = pickTickIndices(hours.length, 4);
  const ticks = tickIdx.map((i) => ({
    x: round2(xFor(Date.parse(hours[i].t))),
    label: fmtTimeCompact(hours[i].t, tz),
  }));

  return (
    // Decorative: the current-hour word + peakNote already carry the reading
    // in accessible text, so this SVG is hidden from assistive tech (same
    // convention as TideCurve).
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 w-full" aria-hidden="true">
      <defs>
        <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${fillId})`} />
      <path d={d} fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {nowPt ? (
        <circle cx={round2(nowPt.x)} cy={round2(nowPt.y)} r="3" fill={stroke} stroke="#0f172a" strokeWidth="1.5" />
      ) : null}
      {nowPt && nowLabelY != null ? (
        <text
          x={round2(nowPt.x)}
          y={nowLabelY}
          textAnchor="middle"
          fontSize="8"
          fontWeight={600}
          fill={stroke}
        >
          now
        </text>
      ) : null}
      {ticks.map((t, i) => (
        <text
          key={i}
          x={t.x}
          y={CURVE_H + 10}
          textAnchor={i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"}
          fontSize="8"
          className="fill-slate-400 dark:fill-slate-500"
        >
          {t.label}
        </text>
      ))}
    </svg>
  );
}

/** Rank a band word so "rising"/"peak" comparisons are a plain number
 *  compare — low < moderate < high. */
const BAND_RANK: Record<BandedRipRisk, number> = { low: 0, moderate: 1, high: 2 };

/** "12 PM Fri" — full AM/PM (not fmtTimeCompact's single-letter form) plus a
 *  short weekday, for the strip's spoken-out aria-label. Drops a :00 minute
 *  for a clean "12 PM" rather than "12:00 PM". */
function fmtAriaTime(iso: string, tz: string): string {
  const time = fmtTime(iso, tz).replace(/:00(?=\s)/, "");
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(new Date(iso));
  return `${time} ${weekday}`;
}

/** One spoken summary of the whole 24h strip for screen readers, e.g.
 *  "Low now, rising to High by 12 PM Friday" or "High now, steady through
 *  the next 24 hours" — the bars themselves are hidden from assistive tech
 *  (aria-hidden), so this is the only accessible description of the shape. */
function stripAriaLabel(hours: { t: string; prob: number }[], tz: string): string {
  const nowLevel = levelForModelProb(hours[0].prob);
  let peakLevel = nowLevel;
  let peakIdx = 0;
  for (let i = 1; i < hours.length; i++) {
    const level = levelForModelProb(hours[i].prob);
    if (BAND_RANK[level] > BAND_RANK[peakLevel]) {
      peakLevel = level;
      peakIdx = i;
    }
  }
  if (BAND_RANK[peakLevel] <= BAND_RANK[nowLevel]) {
    return `${BAND_LABEL[nowLevel]} now, steady through the next 24 hours`;
  }
  return `${BAND_LABEL[nowLevel]} now, rising to ${BAND_LABEL[peakLevel]} by ${fmtAriaTime(hours[peakIdx].t, tz)}`;
}

// Bar geometry: a minimum visible sliver even at 2-3% (item 1) so a quiet
// day still reads as a chart, not an empty strip — full height (~40px) is
// reserved for 100%.
const STRIP_BAR_H = 40;
const STRIP_MIN_BAR = 4;

/**
 * 24-hour strip of the NOAA model's hourly rip probability: one bar per
 * hour, colored by app category (Low/Moderate/High), a "now" marker, hour
 * labels every 6h, and the alert window as an underline beneath the covered
 * hours. Bars are decorative (aria-hidden) — `role="img"` on the wrapper
 * carries the one spoken summary instead of 24 individual numbers.
 */
function ModelStrip({
  series,
  ripNow,
  nowMs,
  tz,
}: {
  series: RipNwpsBeachSeries;
  ripNow: RipNow | undefined;
  nowMs: number | null;
  tz: string;
}) {
  const startMs = nowMs != null ? Math.floor(nowMs / 3_600_000) * 3_600_000 : Date.parse(series.hours[0]?.t ?? "");
  if (!Number.isFinite(startMs)) return null;
  const next24 = series.hours.filter((h) => {
    const t = Date.parse(h.t);
    return t >= startMs && t < startMs + 24 * 3_600_000;
  });
  if (!next24.length) return null;

  const alert = ripNow?.alert ?? ripNow?.upcomingAlert ?? null;
  const alertStartMs = alert ? Date.parse(alert.onset) : null;
  const alertEndMs = alert ? Date.parse(alert.end) : null;
  const alertHourCount = next24.filter((h) => {
    const tMs = Date.parse(h.t);
    return (
      alertStartMs != null && alertEndMs != null && tMs < alertEndMs && tMs + 3_600_000 > alertStartMs
    );
  }).length;
  // "if it fits" (item 1): a one-or-two-cell sliver is too narrow to hold a
  // legible label, so only caption the underline once the window covers a
  // meaningful stretch of the strip.
  const showAlertLabel = alertHourCount >= 4;

  // Ticks every 6h: "Now" for the current hour, then that hour's clock time
  // for +6h/+12h/+18h (e.g. "Now · 6p · 12a · 6a").
  const tickIdxs = [0, 6, 12, 18].filter((i) => i < next24.length);

  return (
    <div
      className="mt-2"
      role="img"
      aria-label={stripAriaLabel(next24, tz)}
    >
      <div className="flex items-end gap-[2px]" style={{ height: STRIP_BAR_H }} aria-hidden="true">
        {next24.map((h, i) => {
          const tMs = Date.parse(h.t);
          const level = levelForModelProb(h.prob);
          const heightPx = Math.round(
            STRIP_MIN_BAR + (Math.max(0, Math.min(100, h.prob)) / 100) * (STRIP_BAR_H - STRIP_MIN_BAR)
          );
          const isNowCell = nowMs != null && tMs <= nowMs && tMs + 3_600_000 > nowMs;
          // Overlap, not point-in-time (item 11): an alert that starts or
          // ends mid-hour still marks the WHOLE bucket, so a statement
          // beginning at 2:30am still underlines the 2am cell.
          const inAlertWindow =
            alertStartMs != null &&
            alertEndMs != null &&
            tMs < alertEndMs &&
            tMs + 3_600_000 > alertStartMs;
          return (
            <div key={i} className="flex flex-1 flex-col items-end justify-end self-end">
              <div
                className="w-full rounded-sm"
                style={{
                  height: heightPx,
                  backgroundColor: MODEL_BAND_FILL[level],
                  opacity: isNowCell ? 1 : 0.7,
                  outline: isNowCell ? "1.5px solid #0f172a" : undefined,
                }}
                title={`${fmtTimeCompact(h.t, tz)}: ${Math.round(h.prob)}% (${BAND_LABEL[level]})`}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-0.5 flex h-1 gap-[2px]" aria-hidden="true">
        {next24.map((h, i) => {
          const tMs = Date.parse(h.t);
          const inAlertWindow =
            alertStartMs != null &&
            alertEndMs != null &&
            tMs < alertEndMs &&
            tMs + 3_600_000 > alertStartMs;
          return (
            <div
              key={i}
              className="h-full flex-1 rounded-full"
              style={{ backgroundColor: inAlertWindow ? "#e11d48" : "transparent" }}
            />
          );
        })}
      </div>
      {showAlertLabel ? (
        <div className="mt-0.5 text-center text-[9px] font-medium text-rose-600 dark:text-rose-400">
          Warning
        </div>
      ) : null}
      <div className="mt-1 flex text-[9px] text-slate-400 dark:text-slate-500" aria-hidden="true">
        {tickIdxs.map((i, k) => (
          <span
            key={i}
            className="flex-1"
            style={{ textAlign: k === 0 ? "left" : k === tickIdxs.length - 1 ? "right" : "center" }}
          >
            {i === 0 ? "Now" : fmtTimeCompact(next24[i].t, tz)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Capitalize just the first character — peakNote reads lowercase-first for
 *  inline use ("riskiest 2-4 PM around low tide") but wants a capital when
 *  it opens a standalone sentence. */
function sentence(s: string): string {
  return s.length ? s.charAt(0).toUpperCase() + s.slice(1) + "." : s;
}

/**
 * Build the flip-back "data nerd" explainer. Self-contained (props only), no
 * dependency on lib/nerdInfo.ts's snapshot-driven registry — same pattern as
 * MarineStingerCard's `buildInfo`.
 */
function buildInfo(
  curve: RipRiskCurve | null,
  ripNwps: RipNwpsBeachSeries | null,
  ripNow: RipNow | undefined,
  tz: string,
): NerdInfo {
  const modelBlock: string[] = ripNwps
    ? [
        `NOAA rip current model (office ${ripNwps.office.toUpperCase()}) — nearest grid point ` +
          `${ripNwps.point.lat.toFixed(4)}, ${ripNwps.point.lon.toFixed(4)}`,
        `Model run: ${fmtRunLabel(ripNwps.run, tz)}`,
        "Threshold mapping (this app's own — see formula below): Low < 20%, Moderate 20-49%, High ≥ 50%",
        "Red underline on the hourly strip = when the official NWS rip current warning (a Rip Current Statement) is in effect",
      ]
    : [];

  // Raw detail moved off the front of the card (2026-09-24 wording pass):
  // the model's own raw %, the SRF word it's being read against, and any
  // scheduled warning — named plainly, all on the flip-back only.
  const ripNowBlock: string[] = [];
  if (ripNow?.model) {
    ripNowBlock.push(
      `NOAA model reading right now: ${Math.round(ripNow.model.prob)}% → ${BAND_LABEL[levelForModelProb(ripNow.model.prob)]}`,
    );
  }
  if (ripNow?.period && ripNow.period.level !== "unknown") {
    ripNowBlock.push(
      `NWS Surf Zone Forecast word for this period (${ripNow.period.periodLabel}): ${BAND_LABEL[ripNow.period.level as BandedRipRisk]}`,
    );
  }
  if (ripNow?.upcomingAlert) {
    ripNowBlock.push(
      `${ripNow.upcomingAlert.event} scheduled: begins ${fmtRunLabel(ripNow.upcomingAlert.onset, tz)}`,
    );
  }

  // SRF/curve wording always describes the CURVE's own anchor word
  // (curve.level) — never the card's headline `band`, which is the
  // RESOLVED now-status and can legitimately differ (an in-effect alert, or
  // a fresh model reading, can outrank the day's SRF word). Conflating the
  // two here would misdescribe the curve/SRF band math with the wrong word
  // (item 2).
  const computation = [
    ...(!curve
      ? modelBlock
      : curve.unshaped
        ? [...modelBlock, `Official NWS Surf Zone Forecast word today: ${BAND_LABEL[curve.level]}`, sentence(curve.peakNote)]
        : (() => {
            const { min, max } = BAND_RANGE[curve.level];
            const scores = curve.hours.map((h) => h.score);
            return [
              ...modelBlock,
              `Official NWS Surf Zone Forecast word today: ${BAND_LABEL[curve.level]} → curve lives in ${min}-${max}`,
              Math.min(...scores) === Math.max(...scores)
                ? `Modulators net flat today → ${scores[0]}/100 across daylight hours`
                : `Today's curve ranges ${Math.min(...scores)}-${Math.max(...scores)}/100 across daylight hours`,
              sentence(curve.peakNote),
            ];
          })()),
    ...ripNowBlock,
  ];

  return {
    title: "Rip current risk",
    // Purely informational — never feeds the Beach Day composite score. The
    // existing NWS-word/model rip cap in lib/score.ts is untouched by this card.
    weightPct: null,
    explainer: ripNwps
      ? "NOAA/NWS hourly model guidance: the Nearshore Wave Prediction System (NWPS) rip current model " +
        "(Dusek & Seim 2013) gives a 0-100% probability of hazardous rip currents for every hour, up to 6 days " +
        "out. Inputs: nearshore significant wave height, wave period + direction, and tidal elevation, from a " +
        "coupled wave/water-level model at the nearest offshore grid point. This card shows that raw " +
        "probability directly, alongside the app's own Low/Moderate/High category for it (see thresholds " +
        "below) — the raw number and the category are not the same thing."
      : "The National Weather Service's Surf Zone Forecast gives one rip-current word for the WHOLE day — " +
        "Low, Moderate, or High. This card turns that into an hour-by-hour shape: wave energy, tide phase, and " +
        "a minor onshore-wind nudge move the NUMBER up or down within the official day's range. The WORD itself " +
        "never changes — a Moderate day can never numerically read as a High day.",
    formula: ripNwps
      ? "NOAA/NWS does not publish a documented probability-to-Low/Moderate/High table for this model (checked: " +
        "the model's Virtual Lab page, NWS beach-hazard pages, surf-zone-forecast product guides — none give " +
        "numeric cutoffs). Absent an official table, THIS APP uses: Low < 20%, Moderate 20-49%, High ≥ 50%, " +
        "applied to each hour's own single published probability value (the file publishes one value per hour; " +
        "there is no sub-hourly interpolation or within-hour max to take)."
      : "Band floor/ceiling by official word: low 5-35, moderate 30-65, high 60-95 (same 35-pt width for " +
        "moderate/high, so a moderate hour is always ~30 points below its high-day twin). " +
        "factor = 0.55×wave + 0.35×tide + 0.10×wind (each 0-1; 0.5 = neutral/unavailable). " +
        "wave = lerp(heightFt×periodS). tide bumps within ±2h of a low-tide event, and (damped) at the " +
        "midpoint of a strong outgoing high→low leg. score = bandMin + factor×(bandMax−bandMin).",
    computation,
    sources: [
      ...(ripNwps
        ? ["NOAA/NWS Nearshore Wave Prediction System (NWPS) rip current model — hourly probability, 6-day"]
        : []),
      "NOAA/NWS Surf Zone Forecast — the day's official rip-current word",
      "Open-Meteo Marine hourly forecast — wave height + period",
      "NOAA CO-OPS tide predictions — high/low events",
    ],
    notes:
      "Resolution order for the top-line NOW status, most-authoritative first: an actual NWS Rip Current " +
      "Statement ACTUALLY IN EFFECT right now (always High); a fresh NOAA rip current model reading for this " +
      "hour, which can be softened one band below a disagreeing Surf Zone Forecast word (or, once the model's " +
      "run starts aging, can only upgrade that word, never downgrade it); or, with no fresh model, the current " +
      "Surf Zone Forecast period's word itself. When the resolved level reads lower than the current forecast " +
      "word, the card adds a 'rising to…' (or otherwise names the disagreement) watch note rather than showing " +
      "the lower level bare. Lifeguard flags are NOT an input here; they're a separate, real-time display " +
      "elsewhere on the page, and are always the ones to follow on the sand.",
  };
}

export interface RipRiskCardProps {
  /** Output of lib/ripRiskCurve.ts's `ripRiskCurve()` — pass it straight
   *  through. `null` (no official NWS word to anchor to) renders nothing. */
  curve: RipRiskCurve | null;
  /** Beach's IANA timezone — formats the sparkline's hour-axis labels
   *  ("7a  11a  3p  7p") in beach-local time, matching the curve's hours. */
  tz: string;
  /** The temporally-resolved "right now" status (lib/ripRisk's resolveRipNow,
   *  already computed by the caller against the dashboard's pinned `nowMs`).
   *  Drives the lead line's source label + the "Low now, rising to High"
   *  watch message. Optional — its absence just hides those, never breaks
   *  the curve/sparkline below it. */
  ripNow?: RipNow;
  /** NOAA's official hourly rip current model series for this beach, when
   *  mapped (config/nwpsRip.ts) and fresh — drives the 24h probability strip
   *  and the "NOAA model run …" line. A beach with only the SRF word (no
   *  model coverage) still gets the rest of the card. */
  ripNwps?: RipNwpsBeachSeries | null;
  /** The dashboard's own minute-ticking, hydration-safe clock (item 5) —
   *  ConditionsDashboard.tsx's `nowMs`, pinned to `generatedAt` on first
   *  render and ticking every 60s post-mount. This card no longer keeps its
   *  own separate timer: `ripNow` is already resolved against this same
   *  clock by the caller, so a second, independently-ticking clock here
   *  could only ever drift from it, never help. `null` before the caller's
   *  own clock has initialized (matches the old first-render behavior). */
  nowMs: number | null;
}

/**
 * Hourly rip-current risk card: a small sparkline of today's daylight curve,
 * the current-hour band word + score, and the peakNote callout. Mirrors
 * MetricCard/FlipCard conventions used across the dashboard. Renders nothing
 * when there's no curve to show (honest-null from the official NWS level, or
 * before this card has been wired up with data) — never a placeholder guess.
 */
export function RipRiskCard({ curve, tz, ripNow, ripNwps, nowMs }: RipRiskCardProps) {

  const hasModel = !!ripNwps?.hours?.length;
  // Beaches with only the NOAA model (no SRF word to anchor lib/ripRiskCurve.ts's
  // curve) still get the card — the model IS the official source there. Only
  // bail when NEITHER a curve nor a model series is available.
  if (!curve && !hasModel) return null;

  // HEADLINE band comes from the resolved NOW status (ripNow) — alert > model
  // > SRF forecast, per lib/ripRisk/resolve.ts's hierarchy — never from the
  // card's own curve.level, which anchors to the SRF word alone and can
  // disagree with what's actually driving risk right now (an in-effect
  // alert, or a fresher NOAA model reading). The curve's SRF word, when it
  // disagrees with the headline, is shown separately below as context.
  const band: BandedRipRisk =
    ripNow && ripNow.level !== "unknown"
      ? (ripNow.level as BandedRipRisk)
      : curve != null
        ? curve.level
        : "low";
  // Plain, non-contradicting front-of-card copy (lib/ripRisk/copy.ts) — one
  // level word, at most two short sentences, no percentages or model names.
  // Pinned to the same nowMs the rest of the dashboard uses (SSR = generatedAt).
  const copy = ripCopy(ripNow, ripNwps?.hours ?? null, nowMs ?? 0, tz);

  const front = (
    <div className="flex h-full flex-col rounded-2xl bg-white/80 p-4 ring-1 ring-slate-900/10 dark:bg-slate-900/70 dark:ring-white/10">
      <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
        <span aria-hidden>🌊</span>
        <span>Rip current risk</span>
        {sourceLabel(ripNow) ? (
          <span className="ml-auto rounded-full bg-slate-500/10 px-2 py-0.5 text-[10px] font-medium text-slate-500 dark:text-slate-400">
            NOAA
          </span>
        ) : null}
      </div>

      <div className="mt-1">
        <span className={`text-xl font-semibold sm:text-2xl ${BAND_TEXT_CLASS[band]}`}>
          {BAND_LABEL[band]}
        </span>
      </div>

      <div className="mt-1 text-sm text-slate-700 dark:text-slate-300">
        <div>{copy.line1}</div>
        {copy.line2 ? <div>{copy.line2}</div> : null}
      </div>

      {hasModel ? (
        <ModelStrip series={ripNwps!} ripNow={ripNow} nowMs={nowMs} tz={tz} />
      ) : curve && !curve.unshaped ? (
        <Sparkline hours={curve.hours} band={band} nowMs={nowMs} tz={tz} />
      ) : null}

      <div className="mt-1 break-words text-xs text-slate-600 dark:text-slate-400">
        Hourly rip current risk · Always follow the lifeguard flags.
      </div>
    </div>
  );

  return (
    <FlipCard
      label="Rip current risk"
      front={front}
      back={<NerdBack info={buildInfo(curve, ripNwps ?? null, ripNow, tz)} />}
    />
  );
}
