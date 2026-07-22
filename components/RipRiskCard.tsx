"use client";

import { useEffect, useState } from "react";
import { BAND_RANGE, type BandedRipRisk, type RipRiskCurve } from "@/lib/ripRiskCurve";
import type { NerdInfo } from "@/lib/nerdInfo";
import { FlipCard, NerdBack } from "@/components/FlipCard";

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
const H = 56;
const PX = 4;
const PT = 6;
const PB = 6;
const round2 = (v: number) => Math.round(v * 100) / 100;

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
}: {
  hours: RipRiskCurve["hours"];
  band: BandedRipRisk;
  nowMs: number | null;
}) {
  if (hours.length < 2) return null;
  const { min, max } = BAND_RANGE[band];
  const span = Math.max(max - min, 1);

  const t0 = Date.parse(hours[0].t);
  const tN = Date.parse(hours[hours.length - 1].t);
  const spanT = Math.max(tN - t0, 1);
  const xFor = (t: number) => PX + ((t - t0) / spanT) * (W - 2 * PX);
  const yFor = (score: number) => PT + (1 - (score - min) / span) * (H - PT - PB);

  const pts = hours.map((h) => ({ x: xFor(Date.parse(h.t)), y: yFor(h.score) }));
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${round2(p.x)} ${round2(p.y)}`).join(" ");
  const area = `${d} L${round2(pts[pts.length - 1].x)} ${H - PB} L${round2(pts[0].x)} ${H - PB} Z`;

  const stroke = BAND_STROKE[band];
  const fillId = BAND_FILL_ID[band];

  const nowVisible = nowMs != null && nowMs >= t0 && nowMs <= tN;
  const nowIdx = nowVisible ? currentHourIndex(hours, nowMs as number) : -1;
  const nowPt = nowIdx >= 0 ? pts[nowIdx] : null;

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
    </svg>
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
function buildInfo(curve: RipRiskCurve, band: BandedRipRisk): NerdInfo {
  const { min, max } = BAND_RANGE[band];
  const scores = curve.hours.map((h) => h.score);

  const computation = curve.unshaped
    ? [
        `Official NWS Surf Zone Forecast word today: ${BAND_LABEL[band]} → band ${min}-${max}`,
        "No usable wave/tide detail today → hourly detail unavailable (no numeric curve invented)",
        sentence(curve.peakNote),
      ]
    : [
        `Official NWS Surf Zone Forecast word today: ${BAND_LABEL[band]} → curve lives in ${min}-${max}`,
        Math.min(...scores) === Math.max(...scores)
          ? `Modulators net flat today → ${scores[0]}/100 across daylight hours`
          : `Today's curve ranges ${Math.min(...scores)}-${Math.max(...scores)}/100 across daylight hours`,
        sentence(curve.peakNote),
      ];

  return {
    title: "Rip current risk (hourly estimate)",
    // Purely informational — never feeds the Beach Day composite score. The
    // existing NWS-word rip cap in lib/score.ts is untouched by this card.
    weightPct: null,
    explainer:
      "The National Weather Service's Surf Zone Forecast gives one rip-current word for the WHOLE day — " +
      "Low, Moderate, or High. This card turns that into an hour-by-hour shape: wave energy (bigger, " +
      "longer-period swell pulls harder than short wind chop of the same height), tide phase (rip currents " +
      "typically strengthen in the ~2 hours around low tide and during a strong outgoing/falling flow), and " +
      "a minor onshore-wind nudge move the NUMBER up or down within the official day's range. The WORD itself " +
      "never changes — a Moderate day can never numerically read as a High day.",
    formula:
      "Band floor/ceiling by official word: low 5-35, moderate 30-65, high 60-95 (same 35-pt width for " +
      "moderate/high, so a moderate hour is always ~30 points below its high-day twin). " +
      "factor = 0.55×wave + 0.35×tide + 0.10×wind (each 0-1; 0.5 = neutral/unavailable). " +
      "wave = lerp(heightFt×periodS). tide bumps within ±2h of a low-tide event, and (damped) at the " +
      "midpoint of a strong outgoing high→low leg. score = bandMin + factor×(bandMax−bandMin).",
    computation,
    sources: [
      "NOAA/NWS Surf Zone Forecast — today's official rip-current word",
      "Open-Meteo Marine hourly forecast — wave height + period",
      "NOAA CO-OPS tide predictions — high/low events",
    ],
    notes:
      "An ESTIMATE layered on top of the official NWS level — not a replacement for it, and not a new scored " +
      "factor (the app's existing rip-current safety cap on the Beach Day score, driven by the official word " +
      "alone, stays authoritative). Always follow the lifeguard flags actually flying over the sand — they " +
      "reflect real-time conditions this curve can't see.",
  };
}

export interface RipRiskCardProps {
  /** Output of lib/ripRiskCurve.ts's `ripRiskCurve()` — pass it straight
   *  through. `null` (no official NWS word to anchor to) renders nothing. */
  curve: RipRiskCurve | null;
}

/**
 * Hourly rip-current risk card: a small sparkline of today's daylight curve,
 * the current-hour band word + score, and the peakNote callout. Mirrors
 * MetricCard/FlipCard conventions used across the dashboard. Renders nothing
 * when there's no curve to show (honest-null from the official NWS level, or
 * before this card has been wired up with data) — never a placeholder guess.
 */
export function RipRiskCard({ curve }: RipRiskCardProps) {
  // "Now" is client-only (set after mount) so SSR and hydration HTML agree —
  // same convention as TideCurve/FlipCard's reduced-motion detection.
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  if (!curve) return null;

  // The official NWS band word — always present, even with no hourly curve. The
  // anchor word never contradicts the official level (see lib/ripRiskCurve.ts).
  const band = curve.level;

  // A live "/100 right now" is honest ONLY when the clock actually falls inside
  // a represented daylight bucket. Before dawn / after the last bucket (and for
  // an unshaped word-only curve) we show the official word WITHOUT a now-number,
  // instead of silently pinning to the first/last bucket and still saying "now".
  const HOUR_MS = 3_600_000;
  const nowInWindow =
    !curve.unshaped &&
    nowMs != null &&
    curve.hours.length > 0 &&
    nowMs >= Date.parse(curve.hours[0].t) &&
    nowMs < Date.parse(curve.hours[curve.hours.length - 1].t) + HOUR_MS;
  const current = nowInWindow ? curve.hours[currentHourIndex(curve.hours, nowMs as number)] : null;

  const front = (
    <div className="flex h-full flex-col rounded-2xl bg-white/80 p-4 ring-1 ring-slate-900/10 dark:bg-slate-900/70 dark:ring-white/10">
      <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
        <span aria-hidden>🌊</span>
        <span>Rip current risk</span>
      </div>

      <div className="mt-1 flex items-baseline gap-2">
        <span className={`text-xl font-semibold sm:text-2xl ${BAND_TEXT_CLASS[band]}`}>
          {BAND_LABEL[band]}
        </span>
        {current ? (
          <span className="text-xs text-slate-500 dark:text-slate-400">{current.score}/100 right now</span>
        ) : (
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {curve.unshaped ? "official NWS level · hourly detail unavailable" : "official NWS level today"}
          </span>
        )}
      </div>

      {curve.unshaped ? null : <Sparkline hours={curve.hours} band={band} nowMs={nowMs} />}

      <div className="mt-1 break-words text-xs text-slate-600 dark:text-slate-400">
        {sentence(curve.peakNote)} Estimate layered on the official NWS level — always follow the lifeguard flags.
      </div>
    </div>
  );

  return <FlipCard label="Rip current risk" front={front} back={<NerdBack info={buildInfo(curve, band)} />} />;
}
