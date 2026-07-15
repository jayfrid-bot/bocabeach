"use client";

import { useEffect, useState } from "react";
import type { SunData } from "@/lib/types";
import { fmtTime } from "@/lib/format";
import {
  arcPoint,
  daylightFraction,
  daylightStatusLabel,
  goldenHourWindows,
  isDaylight,
  isGoldenHour,
  nightArcPoint,
  nightProgress,
  round2,
  type ArcGeometry,
} from "@/lib/sunArc";

// viewBox geometry.
const W = 320;
const H = 150;
const PX = 22;
const HORIZON_Y = 88;
const APEX_Y = 22;
const NIGHT_DEPTH = 30;
const GEO: ArcGeometry = { width: W, paddingX: PX, horizonY: HORIZON_Y, apexY: APEX_Y };

const STEPS = 28;
const dayArcPath = Array.from({ length: STEPS + 1 }, (_, i) => {
  const p = arcPoint(i / STEPS, GEO);
  return `${i === 0 ? "M" : "L"}${p.x} ${p.y}`;
}).join(" ");
const nightArcPath = Array.from({ length: STEPS + 1 }, (_, i) => {
  const p = nightArcPoint(i / STEPS, { ...GEO, nightDepth: NIGHT_DEPTH });
  return `${i === 0 ? "M" : "L"}${p.x} ${p.y}`;
}).join(" ");

/**
 * The sun's pass across today's sky as an arc dial: sunrise-to-sunset with a
 * glowing sun dot at "now" (honest to real solar noon when known), golden-hour
 * shading near both ends, and — on the arc's underside — the moon, either
 * traveling tonight's dark span or (by day) a compact readout of tonight's
 * phase so the retired MoonPanel's info still lives here.
 */
export function SunArc({ sun, tz }: { sun: SunData; tz: string }) {
  // Clock is client-only (set after mount) so SSR and hydration HTML match —
  // pre-mount we render the arc with no sun/moon dot at all (neutral state).
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const sunriseMs = sun.sunrise ? new Date(sun.sunrise).getTime() : null;
  const sunsetMs = sun.sunset ? new Date(sun.sunset).getTime() : null;
  const solarNoonMs = sun.solarNoon ? new Date(sun.solarNoon).getTime() : undefined;
  if (sunriseMs == null || sunsetMs == null || sunsetMs <= sunriseMs) return null;
  const span = { sunriseMs, sunsetMs, solarNoonMs };

  const daylight = nowMs != null ? isDaylight(nowMs, span) : null;
  const golden = nowMs != null && daylight ? isGoldenHour(nowMs, span) : false;
  const statusLabel = nowMs != null ? daylightStatusLabel(nowMs, span) : null;
  const nightFrac = nowMs != null && daylight === false ? nightProgress(nowMs, span) : null;

  const sunDot = nowMs != null && daylight ? arcPoint(daylightFraction(nowMs, span), GEO) : null;
  const moonDot = nightFrac != null ? nightArcPoint(nightFrac, { ...GEO, nightDepth: NIGHT_DEPTH }) : null;

  const golden2 = goldenHourWindows(span);
  const goldenX = golden2
    ? {
        morningEnd: arcPoint(daylightFraction(golden2.morning.endMs, span), GEO).x,
        eveningStart: arcPoint(daylightFraction(golden2.evening.startMs, span), GEO).x,
      }
    : null;

  const apex = arcPoint(0.5, GEO);
  const moon = sun.moonPhase;

  return (
    <div className="mt-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={
          daylight == null
            ? "Sun arc, loading"
            : daylight
              ? `Daytime. ${statusLabel ?? ""}`
              : `Nighttime.${moon ? ` Tonight is ${moon.phase}, ${moon.illumination}% illuminated.` : ""}`
        }
      >
        <defs>
          <radialGradient id="sunarc-glow" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor="#fbbf24" stopOpacity="0.6" />
            <stop offset="100%" stopColor="#fbbf24" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="sunarc-moonglow" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor="#cbd5e1" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#cbd5e1" stopOpacity="0" />
          </radialGradient>
          {/* Sky gradient behind the arc: warm daylight wash vs. deep night. */}
          <linearGradient id="sunarc-sky-day" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#38bdf8" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="sunarc-sky-night" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#312e81" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#312e81" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="sunarc-ground-night" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0f172a" stopOpacity="0" />
            <stop offset="100%" stopColor="#0f172a" stopOpacity="0.28" />
          </linearGradient>
        </defs>

        {/* sky wash under the day arc, keyed to day/night */}
        <path
          d={`${dayArcPath} L${W - PX} ${HORIZON_Y} L${PX} ${HORIZON_Y} Z`}
          fill={daylight ? "url(#sunarc-sky-day)" : "url(#sunarc-sky-night)"}
        />

        {/* golden-hour shading near both ends, derived from real sunrise/sunset */}
        {golden2 && goldenX ? (
          <>
            <path
              d={`${arcSlice(0, daylightFraction(golden2.morning.endMs, span))} L${goldenX.morningEnd} ${HORIZON_Y} L${PX} ${HORIZON_Y} Z`}
              fill="#fb923c"
              opacity={0.16}
            />
            <path
              d={`${arcSlice(daylightFraction(golden2.evening.startMs, span), 1)} L${W - PX} ${HORIZON_Y} L${goldenX.eveningStart} ${HORIZON_Y} Z`}
              fill="#fb923c"
              opacity={0.16}
            />
            <text x={PX + 4} y={HORIZON_Y - 6} textAnchor="start" fontSize="7.5" className="fill-orange-500/80 dark:fill-orange-400/70">
              golden hour
            </text>
            <text x={W - PX - 4} y={HORIZON_Y - 6} textAnchor="end" fontSize="7.5" className="fill-orange-500/80 dark:fill-orange-400/70">
              golden hour
            </text>
          </>
        ) : null}

        {/* night arc (moon's underside path), only worth drawing once it's dark */}
        {daylight === false ? (
          <path d={`${nightArcPath} L${W - PX} ${HORIZON_Y} L${PX} ${HORIZON_Y} Z`} fill="url(#sunarc-ground-night)" />
        ) : null}

        <path d={dayArcPath} fill="none" className="stroke-slate-300 dark:stroke-slate-700" strokeWidth="1.5" strokeDasharray="3 4" />
        {daylight === false ? (
          <path d={nightArcPath} fill="none" className="stroke-slate-400/50 dark:stroke-slate-600/50" strokeWidth="1" strokeDasharray="2 4" />
        ) : null}
        <line x1={8} y1={HORIZON_Y} x2={W - 8} y2={HORIZON_Y} className="stroke-slate-300 dark:stroke-slate-700" strokeWidth="1.5" />

        {/* solar noon tick */}
        <line x1={apex.x} y1={APEX_Y - 6} x2={apex.x} y2={APEX_Y + 2} stroke="#64748b" strokeWidth="1" />
        {sun.solarNoon ? (
          <text x={apex.x} y={APEX_Y - 10} textAnchor="middle" className="fill-slate-600 dark:fill-slate-400" fontSize="9">
            peak {fmtTime(sun.solarNoon, tz)}
          </text>
        ) : null}

        {/* the sun, glowing gently, at today's real elapsed-daylight fraction —
            position carries the information, the pulse is decorative only */}
        {sunDot ? (
          <g>
            <circle
              cx={sunDot.x}
              cy={sunDot.y}
              r={golden ? 19 : 16}
              fill="url(#sunarc-glow)"
              style={{
                animation: "sunglow 3.5s ease-in-out infinite",
                transformBox: "fill-box",
                transformOrigin: "center",
              }}
            />
            <circle cx={sunDot.x} cy={sunDot.y} r="7" fill={golden ? "#fb923c" : "#fbbf24"} stroke="#0f172a" strokeWidth="2" />
          </g>
        ) : null}

        {/* the moon, traveling the underside of the arc through the night
            (phase name + illumination read out below, not repeated here, so
            it never collides with the dot when night-progress nears 0.5) */}
        {moonDot && moon ? (
          <g>
            <circle cx={moonDot.x} cy={moonDot.y} r="14" fill="url(#sunarc-moonglow)" />
            <circle cx={moonDot.x} cy={moonDot.y} r="6.5" fill="#e2e8f0" stroke="#0f172a" strokeWidth="1.5" />
          </g>
        ) : null}

        {/* sunrise / sunset labels */}
        <text x={PX} y={HORIZON_Y + 16} textAnchor="start" className="fill-slate-600 dark:fill-slate-400" fontSize="9.5">
          🌅 {fmtTime(sun.sunrise!, tz)}
        </text>
        <text x={W - PX} y={HORIZON_Y + 16} textAnchor="end" className="fill-slate-600 dark:fill-slate-400" fontSize="9.5">
          {fmtTime(sun.sunset!, tz)} 🌇
        </text>

        {/* payoff line: daylight remaining / until sunrise. At night without
            a "sunrise in" label (daylightStatusLabel only counts down to
            sunset/today's sunrise) the moon phase readout carries the payoff
            instead, so nothing is ever fabricated. */}
        {statusLabel ? (
          <text x={W / 2} y={HORIZON_Y + 16} textAnchor="middle" className="fill-slate-800 dark:fill-slate-200" fontSize="10" fontWeight="600">
            {statusLabel}
          </text>
        ) : daylight === false && moon ? (
          <text x={W / 2} y={H - 10} textAnchor="middle" className="fill-slate-700 dark:fill-slate-300" fontSize="10" fontWeight="600">
            {moon.emoji} {moon.phase} · {moon.illumination}% lit
          </text>
        ) : null}
      </svg>

      {/* daytime compact moon readout — keeps tonight's phase visible even
          while the SVG is showing the sun, so nothing from the retired
          MoonPanel is lost. Hidden at night (the arc already carries it). */}
      {daylight && moon ? (
        <div className="mt-1.5 flex items-center justify-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-500">
          <span aria-hidden>{moon.emoji}</span>
          <span>
            Tonight: {moon.phase} <span className="text-slate-400 dark:text-slate-600">({moon.illumination}% lit)</span>
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** SVG path for the day-arc segment between fractions f0 and f1 (for the
 *  golden-hour shading regions), sampled at the same resolution as the main arc. */
function arcSlice(f0: number, f1: number): string {
  const steps = 10;
  const pts = Array.from({ length: steps + 1 }, (_, i) => {
    const f = f0 + (f1 - f0) * (i / steps);
    const p = arcPoint(f, GEO);
    return `${i === 0 ? "M" : "L"}${round2(p.x)} ${round2(p.y)}`;
  });
  return pts.join(" ");
}
