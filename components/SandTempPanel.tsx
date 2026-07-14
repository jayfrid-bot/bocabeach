"use client";

import { useEffect, useState } from "react";
import type { HourlyMetrics } from "@/lib/types";
import {
  estimateSandRangeF,
  sandVerdict,
  SAND_SCALE_MIN_F,
  SAND_SCALE_MAX_F,
} from "@/lib/sandTemp";
import { fmtTime } from "@/lib/format";

// viewBox geometry for the daylight curve. PT leaves headroom for the
// per-point temperature labels (and the "now" label) so they aren't clipped
// by the top edge.
const W = 320;
const H = 124;
const PX = 14;
const PT = 30;
const PB = 22;

/**
 * Estimated sand surface temperature: a headline number with a barefoot
 * verdict, a comfort meter, and the curve of how the sand heats and cools
 * across today's daylight hours with a "now" marker. Estimates only — the
 * model runs from ground-surface temp, solar radiation, wind, and recent rain.
 */
export function SandTempPanel({
  hours,
  sunriseIso,
  sunsetIso,
  tz,
  nowCloudCoverPct,
}: {
  hours: HourlyMetrics[];
  sunriseIso?: string;
  sunsetIso?: string;
  tz: string;
  /** Consensus cloud cover for the CURRENT hour (the Sky card's number) — applied
   *  to the bucket containing now so the curve's now-point matches the card. */
  nowCloudCoverPct?: number;
}) {
  // Clock is client-only (set after mount) so SSR and hydration HTML match.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Per-hour sand estimates across the local daylight window (±1h padding).
  const t0 = sunriseIso ? new Date(sunriseIso).getTime() - 36e5 : null;
  const tN = sunsetIso ? new Date(sunsetIso).getTime() + 36e5 : null;
  const rainBefore = (i: number) =>
    [i, i - 1, i - 2].reduce((a, j) => a + (hours[j]?.precipIn ?? 0), 0);
  const pts = hours
    .map((h, i) => {
      // The bucket containing "now" uses the consensus cloud (see prop) so the
      // curve's now-point agrees with the metric card + the score.
      const t = new Date(h.time).getTime();
      const isNowBucket = now != null && t <= now && now < t + 36e5;
      const range = estimateSandRangeF({
        soilTempF: h.soilTempF,
        solarWm2: h.solarWm2,
        windSpeedMph: h.windSpeedMph,
        recentRainIn: rainBefore(i),
        cloudCoverPct: isNowBucket ? (nowCloudCoverPct ?? h.cloudCoverPct) : h.cloudCoverPct,
      });
      return {
        t: new Date(h.time).getTime(),
        time: h.time,
        sand: range?.dunesF,
        surf: range?.surfF,
      };
    })
    .filter(
      (p): p is { t: number; time: string; sand: number; surf: number } =>
        p.sand != null && (t0 == null || tN == null || (p.t >= t0 && p.t <= tN)),
    );

  if (pts.length < 2) return null;

  const lo = Math.min(...pts.map((p) => p.sand), 80);
  const hi = Math.max(...pts.map((p) => p.sand), 100);
  const xFor = (t: number) =>
    PX + ((t - pts[0].t) / Math.max(pts[pts.length - 1].t - pts[0].t, 1)) * (W - 2 * PX);
  const yFor = (f: number) => PT + (1 - (f - lo) / Math.max(hi - lo, 1)) * (H - PT - PB);
  const line = pts
    .map((p, i) => `${i ? "L" : "M"}${xFor(p.t).toFixed(1)} ${yFor(p.sand).toFixed(1)}`)
    .join(" ");

  // Headline = the hour bucket that CONTAINS now under half-open [start, start+1h),
  // matching currentSandRangeF/currentSandTempF (the card + the score) so all
  // three pick the same hour. Falls back to the nearest plotted point.
  const sandAt = (ms: number) => {
    for (const p of pts) if (p.t <= ms && ms < p.t + 36e5) return p;
    const t = Math.max(pts[0].t, Math.min(pts[pts.length - 1].t, ms));
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    return best;
  };
  const current = now != null ? sandAt(now) : null;
  const verdict = current ? sandVerdict(current.sand) : null;
  const nowVisible = now != null && now >= pts[0].t && now <= pts[pts.length - 1].t;
  const meterFrac = current
    ? Math.min(1, Math.max(0, (current.sand - SAND_SCALE_MIN_F) / (SAND_SCALE_MAX_F - SAND_SCALE_MIN_F)))
    : 0;

  // Label ~5 hours across the x-axis (always the last).
  const step = Math.max(1, Math.ceil(pts.length / 5));

  // Decimate the per-point temperature labels like the x-axis (else they
  // collide). Beyond the evenly-spaced ticks, always keep the peak, the
  // trough, and the "now" bucket so the readable numbers are the useful ones.
  let maxI = 0;
  let minI = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].sand > pts[maxI].sand) maxI = i;
    if (pts[i].sand < pts[minI].sand) minI = i;
  }
  const nowI = current ? pts.indexOf(current) : -1;
  // Snap the "now" marker (line + dot) to the CURRENT hour's vertex, not xFor(now):
  // `current` is the bucket containing now and its value is what the headline shows,
  // but at xFor(now) the interpolated line has already sloped away from that value,
  // so a dot at (xFor(now), current.sand) floats off the line. The vertex keeps the
  // dot on the line and consistent with the reported number.
  const nowX = current ? xFor(current.t) : 0;

  return (
    <div className="rounded-2xl bg-white/80 dark:bg-slate-900/70 p-4 ring-1 ring-slate-900/10 dark:ring-white/10">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          <span aria-hidden>🦶</span>
          <span>Sand temperature</span>
          <span className="text-[10px] text-slate-400 dark:text-slate-600">(estimated)</span>
        </div>
        {verdict ? (
          <span
            className="rounded-full px-2.5 py-0.5 text-xs font-semibold text-slate-950"
            style={{ background: verdict.color }}
          >
            {verdict.label}
          </span>
        ) : null}
      </div>

      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-2xl font-semibold text-slate-900 dark:text-white">
          {current
            ? current.surf !== current.sand
              ? `~${current.surf}–${current.sand}°F`
              : `~${current.sand}°F`
            : "—"}
        </span>
      </div>

      {/* barefoot comfort meter — slider marker carries a live temperature
          label so you can read the number without looking up at the headline.
          The gradient bands sit at the TRUE scale positions of the comfort
          boundaries (95/115/130°F on the 75-145 scale → 28.6/57.1/78.6%), so
          the marker's spot on the bar matches the verdict — a 139°F read lands
          deep in the red, not "middle of the bar". */}
      <div
        className="relative mt-6 h-1.5 rounded-full"
        style={{
          background:
            "linear-gradient(to right, #34d399 0%, #34d399 24%, #fbbf24 33%, #fbbf24 53%, #fb923c 61%, #fb923c 75%, #fb7185 83%, #fb7185 100%)",
        }}
      >
        {current ? (
          <>
            <span
              className="absolute -top-6 -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow ring-1 ring-slate-950/30 dark:bg-white dark:text-slate-900 dark:ring-white/20"
              style={{ left: `${meterFrac * 100}%` }}
            >
              ~{current.sand}°F
            </span>
            <span
              className="absolute -top-[3px] h-3 w-3 -translate-x-1/2 rounded-full bg-white ring-2 ring-slate-950"
              style={{ left: `${meterFrac * 100}%` }}
            />
          </>
        ) : null}
      </div>
      {/* zone labels centered under their actual band on the scale (not
          evenly spaced — even spacing made "burn risk" sit at the far right
          while the true 130°F boundary is at ~79%). */}
      <div className="relative mt-1 h-4 text-[10px] text-slate-500">
        <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: "14%" }}>
          barefoot · &lt;95°F
        </span>
        <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: "43%" }}>
          warm · 95°F
        </span>
        <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: "68%" }}>
          sandals · 115°F
        </span>
        <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: "89.5%" }}>
          burn · 130°F+
        </span>
      </div>

      {/* today's heat-up / cool-down curve */}
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-3 w-full" role="img" aria-label="Sand temperature through the day">
        <defs>
          <linearGradient id="sand-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fbbf24" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#fbbf24" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path
          d={`${line} L${xFor(pts[pts.length - 1].t).toFixed(1)} ${H - PB} L${xFor(pts[0].t).toFixed(1)} ${H - PB} Z`}
          fill="url(#sand-fill)"
        />
        <path d={line} fill="none" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round" />
        {/* "now" marker drawn first so the dots + temperature labels sit on top */}
        {nowVisible && current ? (
          <line
            x1={nowX}
            x2={nowX}
            y1={PT - 12}
            y2={H - PB}
            className="stroke-slate-700 dark:stroke-slate-200"
            strokeWidth="1.2"
            strokeDasharray="2 3"
          />
        ) : null}
        {pts.map((p, i) => {
          // Temperature printed above each circle; clamp the anchor at the ends
          // so the first/last labels stay inside the viewBox.
          const x = xFor(p.t);
          const anchor: "start" | "middle" | "end" =
            i === 0 ? "start" : i === pts.length - 1 ? "end" : "middle";
          // Thin the numeric labels (same cadence as the x-axis) but always
          // keep the peak, the trough, and the "now" bucket. Dots stay.
          const showLabel =
            i % step === 0 ||
            i === pts.length - 1 ||
            i === maxI ||
            i === minI ||
            i === nowI;
          return (
            <g key={p.t}>
              {showLabel ? (
                <text
                  x={x}
                  y={yFor(p.sand) - 6}
                  textAnchor={anchor}
                  className="fill-slate-600 dark:fill-slate-300"
                  fontSize="7.5"
                  fontWeight="600"
                >
                  {p.sand}°
                </text>
              ) : null}
              <circle cx={x} cy={yFor(p.sand)} r="2.6" fill={sandVerdict(p.sand).color} />
            </g>
          );
        })}
        {/* the current-moment dot, highlighted on the curve */}
        {nowVisible && current ? (
          <circle
            cx={nowX}
            cy={yFor(current.sand)}
            r="4.5"
            className="fill-slate-700 dark:fill-slate-200 stroke-white dark:stroke-slate-950"
            strokeWidth="2"
          />
        ) : null}
        {pts.map((p, i) =>
          i % step === 0 || i === pts.length - 1 ? (
            <text
              key={`l-${p.t}`}
              x={xFor(p.t)}
              y={H - 8}
              textAnchor="middle"
              className="fill-slate-500 dark:fill-slate-400"
              fontSize="9"
            >
              {fmtTime(p.time, tz).replace(":00 ", "")}
            </text>
          ) : null,
        )}
      </svg>

      <p className="mt-1 text-[10px] text-slate-400 dark:text-slate-600">
        Estimated from modeled ground temp, sun strength, wind, and recent rain —
        calibrated against on-the-beach IR thermometer readings. The curve tracks
        the hotter dune-side sand; firmer sand near the water runs ~10°F cooler.
      </p>
    </div>
  );
}
